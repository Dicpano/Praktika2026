"""Модуль 6. Донавчання готового PPO-агента у зміненому середовищі (ФВ-6.1…6.7).

Два середовища: CartPole-v1 (візок із жердиною) і Acrobot-v1 (дволанковий маятник).
Сценарії змін: фізичні параметри, вітер (випадкові поштовхи), шум датчиків.
"""
from __future__ import annotations

from pathlib import Path

import gymnasium as gym
import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.monitor import Monitor
try:  # SB3 >= 2.6
    from stable_baselines3.common.utils import FloatSchedule as _Sched
except ImportError:  # старіші версії
    from stable_baselines3.common.utils import get_schedule_fn as _Sched
from stable_baselines3.common.vec_env import DummyVecEnv

from core import cache, config, experiment
from core.jobs import reporter

ENVS = {
    "cartpole": {
        "id": "CartPole-v1", "title": "CartPole — візок із жердиною",
        "about": "Агент штовхає візок вліво/вправо, щоб жердина не впала: +1 бал за кожен крок, максимум 500.",
        "defaults": {"length": 0.5, "masspole": 0.1, "gravity": 9.8, "force_mag": 10.0, "wind": 0.0, "noise": 0.0},
        "labels": {"length": "Половина довжини жердини, м", "masspole": "Маса жердини (важча жердина), кг",
                   "gravity": "Сила тяжіння, м/с²", "force_mag": "Сила поштовху, Н",
                   "wind": "Вітер: сила випадкових поштовхів", "noise": "Шум датчиків (СКВ)"},
        "suggest": {"length": 1.5, "masspole": 1.0, "gravity": 19.6, "force_mag": 5.0, "wind": 0.6, "noise": 0.15},
        "range": (0.0, 500.0), "repo": "sb3/ppo-CartPole-v1", "file": "ppo-CartPole-v1.zip",
    },
    "acrobot": {
        "id": "Acrobot-v1", "title": "Acrobot — дволанковий маятник",
        "about": "Агент розгойдує двоколінний маятник, щоб кінець піднявся вище лінії: −1 за кожен крок, "
                 "тож що ближче до 0, то краще (максимум 500 кроків).",
        "defaults": {"LINK_MASS_2": 1.0, "LINK_LENGTH_1": 1.0, "LINK_MASS_1": 1.0, "wind": 0.0, "noise": 0.0},
        "labels": {"LINK_MASS_2": "Маса нижньої ланки, кг", "LINK_LENGTH_1": "Довжина верхньої ланки, м",
                   "LINK_MASS_1": "Маса верхньої ланки, кг", "wind": "Вітер: сила випадкових поштовхів",
                   "noise": "Шум датчиків (СКВ)"},
        "suggest": {"LINK_MASS_2": 2.5, "LINK_LENGTH_1": 1.6, "LINK_MASS_1": 2.0, "wind": 1.5, "noise": 0.2},
        "range": (-500.0, 0.0), "repo": "sb3/ppo-Acrobot-v1", "file": "ppo-Acrobot-v1.zip",
    },
}
# сумісність зі старим інтерфейсом (CartPole)
DEFAULTS = ENVS["cartpole"]["defaults"]
PARAM_UA = ENVS["cartpole"]["labels"]
EVAL_SEEDS = list(range(1000, 1020))  # однакові для «до» і «після»


def hub_file(env: str = "cartpole") -> Path:
    return config.MODELS / "sb3" / ENVS[env]["file"]


def finetuned_file(env: str = "cartpole") -> Path:
    return config.MODELS / f"m6_ppo_{env}_finetuned.zip"


def scratch_file(env: str = "cartpole") -> Path:
    return config.MODELS / f"m6_ppo_{env}_local.zip"


FINETUNED = finetuned_file()   # для сумісності зі старими тестами
SCRATCH = scratch_file()


class Wind(gym.Wrapper):
    """Вітер: на кожному кроці до швидкостей додається випадковий поштовх (нормальний розподіл)."""

    def __init__(self, env, strength: float, seed: int = 0):
        super().__init__(env)
        self.k, self.rng = float(strength), np.random.default_rng(seed)

    def reset(self, **kw):
        if kw.get("seed") is not None:
            self.rng = np.random.default_rng(kw["seed"] + 7)
        return self.env.reset(**kw)

    def step(self, action):
        u = self.env.unwrapped
        if self.k > 0 and getattr(u, "state", None) is not None:
            s = np.array(u.state, dtype=np.float64)
            if len(s) == 4 and hasattr(u, "polemass_length"):     # CartPole: швидкість візка і кутова
                s[1] += self.rng.normal(0, self.k)
                s[3] += self.rng.normal(0, self.k)
            else:                                                  # Acrobot: кутові швидкості ланок
                s[2] += self.rng.normal(0, self.k * 0.3)
                s[3] += self.rng.normal(0, self.k * 0.3)
            u.state = s if isinstance(u.state, np.ndarray) else tuple(s)
        return self.env.step(action)


class Noise(gym.ObservationWrapper):
    """Шум датчиків: агент бачить спостереження з випадковою похибкою."""

    def __init__(self, env, std: float, seed: int = 0):
        super().__init__(env)
        self.std, self.rng = float(std), np.random.default_rng(seed)

    def reset(self, **kw):
        if kw.get("seed") is not None:
            self.rng = np.random.default_rng(kw["seed"] + 13)
        return super().reset(**kw)

    def observation(self, obs):
        return (obs + self.rng.normal(0, self.std, size=obs.shape)).astype(obs.dtype)


def make_env(params: dict | None = None, render_mode: str | None = None, env: str = "cartpole") -> gym.Env:
    params = dict(params or {})
    wind, noise = float(params.pop("wind", 0) or 0), float(params.pop("noise", 0) or 0)
    e = gym.make(ENVS[env]["id"], render_mode=render_mode)
    u = e.unwrapped
    for k, v in params.items():
        setattr(u, k, float(v))
    if env == "cartpole":  # похідні величини CartPole рахуються в __init__, тому перераховуємо їх вручну
        u.total_mass = u.masspole + u.masscart
        u.polemass_length = u.masspole * u.length
    if wind > 0:
        e = Wind(e, wind)
    if noise > 0:
        e = Noise(e, noise)
    return e


class single_thread:
    """PPO з маленькими мережами 64×64 найшвидший в один потік (рекомендація Stable-Baselines3):
    багатопотоковість дає лише накладні витрати й конкуренцію за процесор."""

    def __enter__(self):
        import torch
        self.n = torch.get_num_threads()
        torch.set_num_threads(1)

    def __exit__(self, *exc):
        import torch
        torch.set_num_threads(self.n)


_CUSTOM = {"learning_rate": 0.0, "lr_schedule": lambda _: 0.0, "clip_range": lambda _: 0.0}


def _spaces(env: str = "cartpole") -> dict:
    """Агенти з Hugging Face збережені у старому gym: межі спостережень там ±3.4e38, а в gymnasium 1.x — ±inf.
    Форма та сама, тож підставляємо простори поточного середовища — інакше set_env відмовляє
    («Observation spaces do not match»)."""
    e = make_env(env=env)
    out = {"observation_space": e.observation_space, "action_space": e.action_space}
    e.close()
    return out


def _env_of(path: str) -> str:
    return "acrobot" if "crobot" in Path(path).name else "cartpole"


def _ppo(path: str) -> PPO:
    return PPO.load(path, custom_objects={**_CUSTOM, **_spaces(_env_of(path))}, device="cpu")


def load_pretrained(fresh: bool = True, env: str = "cartpole") -> tuple[PPO, str]:
    """Готовий агент з Hugging Face (rl-zoo) або резервний, навчений у програмі.

    fresh=True — нова копія для донавчання; fresh=False — спільна копія з кешу лише для оцінки й показу.
    """
    get = _ppo if fresh else (lambda p: cache.load(p, _ppo))
    if hub_file(env).exists():
        return get(str(hub_file(env))), f"{ENVS[env]['repo']} (Hugging Face)"
    if scratch_file(env).exists():
        return get(str(scratch_file(env))), "локальний агент (резерв, навчений у програмі)"
    raise FileNotFoundError("Немає готового агента: перезапустіть INSTALL.bat або створіть резервного агента")


def train_local_pretrained(timesteps=None, job=None, env: str = "cartpole") -> None:
    """Резерв без Інтернету: навчає агента в стандартному середовищі (замість завантаження)."""
    j = reporter(job)
    timesteps = timesteps or (60_000 if env == "cartpole" else 120_000)
    j.log(f"резервний агент: PPO з нуля у стандартному {ENVS[env]['id']}, {timesteps} кроків")
    experiment.set_seed()
    kw = (dict(n_steps=512, batch_size=64, gae_lambda=0.8, gamma=0.98, n_epochs=20, ent_coef=0.0, learning_rate=1e-3)
          if env == "cartpole" else dict(n_steps=256, gae_lambda=0.94, gamma=0.99, n_epochs=4, ent_coef=0.0))
    m = PPO("MlpPolicy", DummyVecEnv([lambda: Monitor(make_env(env=env))]), seed=config.SEED, verbose=0, device="cpu", **kw)
    with single_thread():
        m.learn(timesteps, callback=RewardLog(job=j, total=timesteps, lo=0.0, hi=1.0))
    m.save(scratch_file(env))
    j.ok(f"резервного агента збережено → models/{scratch_file(env).name}")


def evaluate(model: PPO, params: dict | None, seeds=None, env: str = "cartpole") -> list[float]:
    seeds = EVAL_SEEDS if seeds is None else seeds
    e = make_env(params, env=env)
    rewards = []
    for s in seeds:
        obs, _ = e.reset(seed=s)
        done, total = False, 0.0
        while not done:
            act, _ = model.predict(obs, deterministic=True)
            obs, r, term, trunc, _ = e.step(int(act))
            total += r
            done = term or trunc
        rewards.append(total)
    e.close()
    return rewards


def summary(rewards: list[float]) -> dict:
    return {"mean_reward": float(np.mean(rewards)), "std_reward": float(np.std(rewards)), "n": len(rewards)}


def norm(reward: float, env: str = "cartpole") -> float:
    """Винагорода у шкалі 0…1 (0 — найгірше, 1 — найкраще), щоб порівнювати середовища."""
    lo, hi = ENVS[env]["range"]
    return (reward - lo) / (hi - lo)


def scan(model: PPO, param: str, values, seeds=None, job=None, env: str = "cartpole") -> dict[float, float]:
    """ФВ-6.3: як змінюється винагорода готового агента залежно від параметра."""
    j = reporter(job)
    seeds = EVAL_SEEDS[:5] if seeds is None else seeds
    out = {}
    for i, v in enumerate(values):
        out[float(v)] = float(np.mean(evaluate(model, {param: v}, seeds, env)))
        j.set((i + 1) / len(values), f"{param} = {v:g}")
        j.log(f"{param} = {v:g} → середня винагорода {out[float(v)]:.1f}")
    return out


class RewardLog(BaseCallback):
    """Збирає криву винагороди, оновлює прогрес задачі й перевіряє скасування на кожному кроці."""

    def __init__(self, job=None, total: int = 1, lo: float = 0.0, hi: float = 1.0):
        super().__init__()
        self.j, self.total, self.lo, self.hi = reporter(job), total, lo, hi
        self.curve, self.start = [], None

    def _on_step(self) -> bool:
        if self.start is None:
            self.start = self.num_timesteps - 1
        done = self.num_timesteps - self.start  # лічильник агента продовжується з попереднього навчання
        if done % 256 == 0:
            self.j.set(self.lo + (self.hi - self.lo) * min(1.0, done / self.total), f"крок {done}/{self.total}")
        for info in self.locals.get("infos", []):
            if "episode" in info:
                self.curve.append((done, float(info["episode"]["r"])))
                if len(self.curve) % 20 == 0:
                    recent = [r for _, r in self.curve[-20:]]
                    self.j.log(f"крок ≈{done:>6} · епізодів {len(self.curve):>4} · середня за 20: {np.mean(recent):6.1f}")
        return True


def freeze_body(model: PPO) -> tuple[int, int]:
    """Заморозити «тіло» мережі (спільні шари mlp_extractor): навчаються лише останні шари action_net і value_net."""
    pol = model.policy
    for prm in list(pol.features_extractor.parameters()) + list(pol.mlp_extractor.parameters()):
        prm.requires_grad = False
    return trainable_params(model)


def trainable_params(model: PPO) -> tuple[int, int]:
    ps = list(model.policy.parameters())
    return sum(p.numel() for p in ps if p.requires_grad), sum(p.numel() for p in ps)


def finetune(model: PPO, params: dict, timesteps=50_000, lr=3e-4, job=None, env: str = "cartpole",
             save: bool = True, lo: float = 0.1, hi: float = 0.9) -> tuple[PPO, list]:
    experiment.set_seed()
    model.set_env(DummyVecEnv([lambda: Monitor(make_env(params, env=env))]))
    model.learning_rate = lr
    model.lr_schedule = _Sched(lr)
    model.clip_range = _Sched(0.2)
    model.set_random_seed(config.SEED)
    log = RewardLog(job=job, total=timesteps, lo=lo, hi=hi)
    with single_thread():
        model.learn(total_timesteps=timesteps, callback=log, reset_num_timesteps=False)
    if save:
        model.save(finetuned_file(env))
    return model, log.curve


def _frames(model: PPO, params: dict, env: str, seed: int, max_frames: int) -> list[np.ndarray]:
    e = make_env(params, render_mode="rgb_array", env=env)
    obs, _ = e.reset(seed=seed)
    frames, done = [e.render()], False
    while not done and len(frames) < max_frames:
        act, _ = model.predict(obs, deterministic=True)
        obs, _, term, trunc, _ = e.step(int(act))
        frames.append(e.render())
        done = term or trunc
    e.close()
    return frames


def record_gif(model: PPO, params: dict, path: Path, seed=None, max_frames=300, env: str = "cartpole") -> Path:
    import imageio.v2 as imageio
    seed = EVAL_SEEDS[0] if seed is None else seed
    imageio.mimsave(path, _frames(model, params, env, seed, max_frames)[::2], duration=0.04, loop=0)
    return path


def record_side_by_side(before: PPO, after: PPO, params: dict, path: Path, seed=None, max_frames=400,
                        env: str = "cartpole") -> Path:
    """Одне відео (GIF): ліворуч агент до донавчання, праворуч — після; однаковий seed, синхронний час."""
    import imageio.v2 as imageio
    from PIL import Image, ImageDraw, ImageFont
    font = None
    for name in ("arial.ttf", "segoeui.ttf", "DejaVuSans.ttf"):   # шрифт з кирилицею: Windows / Linux
        try:
            font = ImageFont.truetype(name, 22)
            break
        except OSError:
            continue
    font = font or ImageFont.load_default()
    seed = EVAL_SEEDS[0] if seed is None else seed
    a, b = _frames(before, params, env, seed, max_frames), _frames(after, params, env, seed, max_frames)
    n = max(len(a), len(b))
    out = []
    for i in range(0, n, 2):
        fa, fb = a[min(i, len(a) - 1)], b[min(i, len(b) - 1)]
        im = Image.fromarray(np.concatenate([fa, np.full((fa.shape[0], 8, 3), 20, np.uint8), fb], axis=1))
        d = ImageDraw.Draw(im)
        for x, label, frames in ((10, "ДО", a), (fa.shape[1] + 18, "ПІСЛЯ", b)):
            fin = " (впав)" if i >= len(frames) - 1 and len(frames) < max_frames and env == "cartpole" else ""
            d.rectangle([x - 6, 4, x + 300, 34], fill=(5, 7, 10))
            d.text((x, 7), f"{label} · крок {min(i, len(frames) - 1)}{fin}", fill=(0, 229, 255), font=font)
        out.append(np.asarray(im))
    imageio.mimsave(path, out, duration=0.04, loop=0)
    return path


def run_experiment(param="length", value=1.5, timesteps=50_000, job=None, env: str = "cartpole",
                   compare_frozen: bool = False) -> dict:
    """Донавчання готового агента в зміненому середовищі.

    compare_frozen — додатково той самий старт, але з замороженим тілом мережі (навчається лише останній шар).
    """
    import time
    j = reporter(job)
    model, source = load_pretrained(env=env)
    changed = {param: value}
    labels = ENVS[env]["labels"]
    j.log(f"середовище {ENVS[env]['id']} · агент: {source} · {labels.get(param, param)}: "
          f"{ENVS[env]['defaults'].get(param)} → {value}")
    j.set(0.02, "оцінка «до»")
    orig_before = summary(evaluate(model, None, env=env))
    before = summary(evaluate(model, changed, env=env))
    j.log(f"до: змінене середовище {before['mean_reward']:.1f} · стандартне {orig_before['mean_reward']:.1f} "
          f"({len(EVAL_SEEDS)} епізодів, фіксовані seed)")
    if norm(before["mean_reward"], env) >= 0.7 * norm(orig_before["mean_reward"], env):
        j.warn("зміна майже не шкодить агенту (падіння < 30 %) — донавчанню нема чого виправляти. "
               f"Для показового результату спробуйте «{labels[next(iter(ENVS[env]['suggest']))]}» = "
               f"{next(iter(ENVS[env]['suggest'].values()))}")
    full_tr, total = trainable_params(model)
    t0 = time.time()
    model, curve = finetune(model, changed, timesteps, job=job, env=env, hi=0.55 if compare_frozen else 0.9)
    full_s = time.time() - t0
    j.set(0.92 if not compare_frozen else 0.57, "оцінка «після»")
    after = summary(evaluate(model, changed, env=env))
    orig_after = summary(evaluate(model, None, env=env))
    frozen = freeze = None
    if compare_frozen:
        j.log(f"повне донавчання: {after['mean_reward']:.1f}. Тепер — з замороженим тілом мережі (лише останній шар)")
        fm, _ = load_pretrained(env=env)
        fr_tr, _ = freeze_body(fm)
        j.log(f"навчуваних параметрів: {fr_tr} з {total} (повне донавчання — {full_tr})")
        t0 = time.time()
        fm, _ = finetune(fm, changed, timesteps, job=job, env=env, save=False, lo=0.6, hi=0.92)
        fr_s = time.time() - t0
        frozen = summary(evaluate(fm, changed, env=env))
        frozen["orig_env"] = summary(evaluate(fm, None, env=env))["mean_reward"]
        j.log(f"заморожене тіло: {frozen['mean_reward']:.1f} · повне: {after['mean_reward']:.1f}")
        freeze = {"metric": "mean_reward", "rows": [
            {"variant": "Лише останній шар (тіло заморожене)", "trainable": fr_tr, "total": total,
             "score": frozen["mean_reward"], "orig": frozen["orig_env"], "seconds": round(fr_s, 1)},
            {"variant": "Уся мережа (повне донавчання)", "trainable": full_tr, "total": total,
             "score": after["mean_reward"], "orig": orig_after["mean_reward"], "seconds": round(full_s, 1)}]}
    params = {"env": env, "agent": source, "param": param, "value": value, "timesteps": timesteps,
              "episodes": len(EVAL_SEEDS), "compare_frozen": compare_frozen}
    metrics = {"baseline": before, "adapted": after, "original_env_before": orig_before, "original_env_after": orig_after}
    if frozen:
        metrics["frozen"] = frozen
    experiment.log_result("m6", params, metrics,
                          notes="baseline = готовий агент у зміненому середовищі; original_env_* — контроль забування")
    res = {"metrics": metrics, "curve": curve, "params": params, "freeze": freeze}
    experiment.save_extra("m6", res)
    j.ok(f"змінене середовище: {before['mean_reward']:.1f} → {after['mean_reward']:.1f}")
    ok = norm(orig_after["mean_reward"], env) >= 0.9 * norm(orig_before["mean_reward"], env)
    j.log(f"контроль забування (стандартне): {orig_before['mean_reward']:.1f} → {orig_after['mean_reward']:.1f}",
          "ok" if ok else "wr")
    return res


if __name__ == "__main__":
    from core.jobs import NullJob
    for e in ENVS:
        try:
            load_pretrained(env=e)
        except FileNotFoundError:
            print(f"[{e}] готового агента немає — навчаю резервного")
            train_local_pretrained(job=NullJob(verbose=True), env=e)
    r = run_experiment(timesteps=20_000, job=NullJob(verbose=True))
    print(r["metrics"])
