"""Симульоване середовище для RL-агента БПЛА (API як у Gymnasium: reset/step).

БПЛА має долетіти з бази (лівий край) до цілі (правий край) сітки N×N,
оминаючи зони ППО. Розташування цілі та зон ППО — нові в кожному епізоді,
тому агент не може «завчити» карту і має навчитися політиці за спостереженнями.

Спостереження (вектор 14 чисел):
  * dx, dy        — нормований вектор до цілі;
  * 8 значень     — чи є зона ППО у 8 сусідніх клітинках (сенсор БПЛА);
  * 2 значення    — чи впирається БПЛА в межу поля по осі x / y (−1/0/+1);
  * battery       — залишок заряду (0..1);
  * in_threat     — чи знаходиться БПЛА зараз у зоні ППО.

Дії: 0 — вгору, 1 — вниз, 2 — вліво, 3 — вправо.

Нагороди:
  +10  досягнення цілі;
  −0.1 кожен крок (стимул до короткого маршруту);
  −10  БПЛА збито (з імовірністю p_hit за кожен крок у зоні ППО);
  −5   розряд батареї;
  −0.5 спроба вилетіти за межі поля;
  shaping: +0.3·(Φ(s') − Φ(s)), де Φ = −(манхеттенська відстань до цілі).
           Це potential-based shaping (Ng et al., 1999): він прискорює навчання
           при рідкісній нагороді і не змінює оптимальну політику.
"""
import numpy as np

MOVES = np.array([[0, -1], [0, 1], [-1, 0], [1, 0]])
NEIGHBORS = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]


class UAVEnv:
    def __init__(self, size=10, n_threats=4, threat_radius=1, p_hit=0.35, max_steps=40, shaping=0.3, seed=None):
        self.size, self.n_threats, self.r = size, n_threats, threat_radius
        self.p_hit, self.max_steps, self.shaping = p_hit, max_steps, shaping
        self.rng = np.random.default_rng(seed)
        self.n_actions, self.obs_dim = 4, 14

    # ------------------------------------------------------------------
    def reset(self, seed=None):
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        n = self.size
        self.pos = np.array([0, self.rng.integers(n)])
        self.target = np.array([n - 1, self.rng.integers(n)])
        self.threat = np.zeros((n, n), dtype=bool)
        centers = []
        while len(centers) < self.n_threats:
            c = np.array([self.rng.integers(2, n - 2), self.rng.integers(n)])
            centers.append(c)
            xs, ys = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            self.threat |= (np.abs(xs - c[0]) <= self.r) & (np.abs(ys - c[1]) <= self.r)
        self.threat[tuple(self.pos)] = self.threat[tuple(self.target)] = False
        self.centers = centers
        self.steps = 0
        self.path = [self.pos.copy()]
        return self._obs(), {}

    def _in_threat(self, p):
        x, y = p
        return 0 <= x < self.size and 0 <= y < self.size and self.threat[x, y]

    def _obs(self):
        d = (self.target - self.pos) / (self.size - 1)
        sensors = [float(self._in_threat(self.pos + np.array(o))) for o in NEIGHBORS]
        wall_x = -1.0 if self.pos[0] == 0 else (1.0 if self.pos[0] == self.size - 1 else 0.0)
        wall_y = -1.0 if self.pos[1] == 0 else (1.0 if self.pos[1] == self.size - 1 else 0.0)
        battery = 1 - self.steps / self.max_steps
        return np.array([*d, *sensors, wall_x, wall_y, battery, float(self._in_threat(self.pos))],
                        dtype=np.float32)

    # ------------------------------------------------------------------
    def step(self, action):
        self.steps += 1
        reward, info = -0.1, {"event": None}
        dist_before = np.abs(self.target - self.pos).sum()
        new = self.pos + MOVES[action]
        if (new < 0).any() or (new >= self.size).any():
            reward -= 0.5
        else:
            self.pos = new
        reward += self.shaping * (dist_before - np.abs(self.target - self.pos).sum())
        self.path.append(self.pos.copy())

        if (self.pos == self.target).all():
            return self._obs(), reward + 10, True, False, {"event": "reached"}
        if self._in_threat(self.pos) and self.rng.random() < self.p_hit:
            return self._obs(), reward - 10, True, False, {"event": "shot_down"}
        if self.steps >= self.max_steps:
            return self._obs(), reward - 5, False, True, {"event": "battery"}
        return self._obs(), reward, False, False, info


# ---------------------------------------------------------------------- baseline policies
def random_policy(env, obs, rng):
    return int(rng.integers(4))


def greedy_policy(env, obs, rng):
    """Найкоротший шлях до цілі, ігноруючи ППО (типовий «прямий» маршрут)."""
    dx, dy = env.target - env.pos
    if abs(dx) >= abs(dy) and dx != 0:
        return 3 if dx > 0 else 2
    return 1 if dy > 0 else 0


def cautious_greedy_policy(env, obs, rng):
    """Евристика оператора: рух до цілі, але оминаючи клітинки, де сенсор бачить ППО."""
    dx, dy = env.target - env.pos
    prefs = []
    if dx: prefs.append(3 if dx > 0 else 2)
    if dy: prefs.append(1 if dy > 0 else 0)
    prefs += [a for a in (3, 1, 0, 2) if a not in prefs]
    for a in prefs:
        nxt = env.pos + MOVES[a]
        if (nxt >= 0).all() and (nxt < env.size).all() and not env._in_threat(nxt):
            return a
    return prefs[0]
