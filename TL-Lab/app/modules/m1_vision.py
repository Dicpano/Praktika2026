"""Модуль 1. Класифікатор техніки й об'єктів на фото: ResNet18 + новий шар fc (ФВ-1.1…1.6).

Класи з менш ніж MIN_PER_CLASS фото автоматично пропускаються під час навчання (з попередженням),
тому модуль працює, навіть поки фото нових класів ще не зібрано."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.models import ResNet18_Weights, resnet18

from core import cache, config, data, experiment, metrics
from core.jobs import reporter

CLASSES = ["uav", "armor", "artillery", "truck", "camo", "none"]
LABELS_UA = {"uav": "БПЛА", "armor": "Бронетехніка", "artillery": "Артилерія", "truck": "Вантажівка",
             "camo": "Замасковані позиції", "none": "Немає цілі (фон)"}
MIN_PER_CLASS = 5
DATA_DIR = config.DATA / "vehicles"
WEIGHTS_FILE = config.MODELS / "m1_resnet18.pt"
UNCERTAIN = 0.6

MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]
TF_EVAL = transforms.Compose([transforms.Resize(256), transforms.CenterCrop(224),
                              transforms.ToTensor(), transforms.Normalize(MEAN, STD)])
TF_AUG = transforms.Compose([transforms.RandomResizedCrop(224, scale=(0.6, 1.0)), transforms.RandomHorizontalFlip(),
                             transforms.ColorJitter(0.3, 0.3, 0.3), transforms.ToTensor(), transforms.Normalize(MEAN, STD)])


def load_image(p) -> Image.Image:
    return Image.open(p).convert("RGB")


class ImgSet(Dataset):
    def __init__(self, paths, labels, tf, classes):
        self.paths, self.y, self.tf = paths, [classes.index(l) for l in labels], tf

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        return self.tf(load_image(self.paths[i])), self.y[i]


def dataset():
    return data.folder_dataset(DATA_DIR, CLASSES, data.IMG_EXT)


def find_duplicates(paths: list[Path], threshold: int = 4) -> list[tuple[str, str]]:
    """Майже однакові фото (простий aHash 8x8). Дублікати в train і test завищують точність."""
    hashes = []
    for p in paths:
        g = np.asarray(load_image(p).convert("L").resize((8, 8)), dtype=np.float32)
        hashes.append((g > g.mean()).flatten())
    out = []
    for i in range(len(paths)):
        for j in range(i + 1, len(paths)):
            if int((hashes[i] != hashes[j]).sum()) <= threshold:
                out.append((paths[i].name, paths[j].name))
    return out


def build_model(unfreeze_layer4: bool = False, pretrained: bool = True, n_classes: int = len(CLASSES)) -> nn.Module:
    m = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1 if pretrained else None)
    for p in m.parameters():
        p.requires_grad = False
    if unfreeze_layer4:
        for p in m.layer4.parameters():
            p.requires_grad = True
    m.fc = nn.Linear(m.fc.in_features, n_classes)  # новий шар навчається
    return m


def train(paths, labels, augment=True, epochs=10, lr=1e-3, batch=16, unfreeze_layer4=False,
          progress: Callable[[int, float], None] | None = None, pretrained=True,
          classes: list[str] | None = None) -> tuple[nn.Module, list[float]]:
    experiment.set_seed()
    classes = classes or CLASSES
    model = build_model(unfreeze_layer4, pretrained, len(classes))
    model.classes = list(classes)
    dl = DataLoader(ImgSet(paths, labels, TF_AUG if augment else TF_EVAL, classes), batch_size=batch, shuffle=True,
                    generator=torch.Generator().manual_seed(config.SEED))
    opt = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=lr)
    lossf, hist = nn.CrossEntropyLoss(), []
    for ep in range(epochs):
        model.train()
        tot = 0.0
        for x, y in dl:
            opt.zero_grad()
            loss = lossf(model(x), y)
            loss.backward()
            opt.step()
            tot += loss.item() * len(y)
        hist.append(tot / len(dl.dataset))
        if progress:
            progress(ep + 1, hist[-1])
    return model.eval(), hist


@torch.no_grad()
def predict_proba(model, images: list[Image.Image]) -> np.ndarray:
    x = torch.stack([TF_EVAL(im) for im in images])
    return torch.softmax(model.eval()(x), 1).numpy()


def evaluate(model, paths, labels) -> tuple[dict, np.ndarray]:
    probs = predict_proba(model, [load_image(p) for p in paths])
    pred = [model.classes[i] for i in probs.argmax(1)]
    return metrics.classification(labels, pred, model.classes), probs


def gradcam(model, image: Image.Image, target: int | None = None) -> tuple[np.ndarray, int]:
    """Grad-CAM за останнім згортковим блоком layer4. Повертає теплову карту 224x224 і клас."""
    acts, grads = {}, {}
    h1 = model.layer4.register_forward_hook(lambda m, i, o: acts.__setitem__("a", o))
    h2 = model.layer4.register_full_backward_hook(lambda m, gi, go: grads.__setitem__("g", go[0]))
    try:
        x = TF_EVAL(image).unsqueeze(0).requires_grad_(True)
        out = model.eval()(x)
        cls = int(out.argmax(1)) if target is None else target
        model.zero_grad()
        out[0, cls].backward()
        w = grads["g"].mean(dim=(2, 3), keepdim=True)
        cam = torch.relu((w * acts["a"]).sum(1)).squeeze().detach()
        cam = torch.nn.functional.interpolate(cam[None, None], size=(224, 224), mode="bilinear")[0, 0].numpy()
        cam = (cam - cam.min()) / (cam.max() - cam.min() + 1e-8)
        return cam, cls
    finally:
        h1.remove()
        h2.remove()


def overlay(image: Image.Image, cam: np.ndarray) -> Image.Image:
    import matplotlib
    base = TF_EVAL.transforms[0](image)
    base = TF_EVAL.transforms[1](base)
    heat = (matplotlib.colormaps["jet"](cam)[..., :3] * 255).astype(np.uint8)
    return Image.blend(base.convert("RGB"), Image.fromarray(heat), 0.45)


def save(model) -> None:
    torch.save({"classes": model.classes, "fc": model.fc.state_dict(), "layer4": model.layer4.state_dict()}, WEIGHTS_FILE)


def _load_file(path: str) -> nn.Module:
    st = torch.load(path, map_location="cpu")
    m = build_model(n_classes=len(st["classes"]))
    m.layer4.load_state_dict(st["layer4"])
    m.fc.load_state_dict(st["fc"])
    m.classes = list(st["classes"])
    return m.eval()


def active_classes(labels: list[str]) -> tuple[list[str], list[str]]:
    """Класи, яких достатньо для навчання, і пропущені (замало фото)."""
    use = [c for c in CLASSES if labels.count(c) >= MIN_PER_CLASS]
    return use, [c for c in CLASSES if c not in use]


def load() -> nn.Module:
    """Адаптована модель з кешу пам'яті (з диска читається лише після нового навчання)."""
    return cache.load(WEIGHTS_FILE, _load_file)


def run_experiment(epochs=10, lr=1e-3, unfreeze=False, test_size=0.3, job=None) -> dict:
    """Повний цикл: поділ → базовий рівень (без аугментації) → адаптація → оцінка → журнал."""
    j = reporter(job)
    paths, labels = dataset()
    use, skipped = active_classes(labels)
    if len(use) < 2:
        raise ValueError(f"Потрібно щонайменше {MIN_PER_CLASS} фото хоча б у двох класах — зберіть фото в «Центрі даних»")
    if skipped:
        j.warn("пропущено (замало фото, < %d): %s" % (MIN_PER_CLASS, ", ".join(LABELS_UA[c] for c in skipped)))
    keep = [i for i, l in enumerate(labels) if l in use]
    paths, labels = [paths[i] for i in keep], [labels[i] for i in keep]
    tr_p, te_p, tr_y, te_y = data.split(paths, labels, test_size)
    j.log(f"класи: {', '.join(LABELS_UA[c] for c in use)}")
    j.log(f"фото: {len(paths)} · train {len(tr_p)} / test {len(te_p)} · ResNet18 IMAGENET1K_V1, fc 512→{len(use)}")

    def prog(stage, lo, hi):
        def f(e, loss):
            j.set(lo + (hi - lo) * e / epochs, f"{stage}: епоха {e}/{epochs}")
            j.log(f"[{stage}] епоха {e:>2}/{epochs}  loss={loss:.4f}")
        return f
    j.log("1/2 базовий рівень: той самий класифікатор без аугментації")
    base_model, _ = train(tr_p, tr_y, augment=False, epochs=epochs, lr=lr, unfreeze_layer4=unfreeze,
                          progress=prog("база", 0.0, 0.45), classes=use)
    base, _ = evaluate(base_model, te_p, te_y)
    j.ok(f"база: F1-macro {base['f1_macro']:.3f}")
    j.log(f"2/2 адаптація з аугментацією, layer4 {'розморожено' if unfreeze else 'заморожено'}")
    model, hist = train(tr_p, tr_y, augment=True, epochs=epochs, lr=lr, unfreeze_layer4=unfreeze,
                        progress=prog("адаптація", 0.5, 0.95), classes=use)
    adapt, probs = evaluate(model, te_p, te_y)
    save(model)
    errors = [{"file": str(p), "true": t, "pred": use[int(pr.argmax())], "conf": float(pr.max())}
              for p, t, pr in zip(te_p, te_y, probs) if use[int(pr.argmax())] != t]
    params = {"epochs": epochs, "lr": lr, "unfreeze_layer4": unfreeze, "train": len(tr_p), "test": len(te_p),
              "classes": use}
    experiment.log_result("m1", params, {"baseline": base, "adapted": adapt},
                          notes="baseline = той самий класифікатор без аугментації")
    res = {"baseline": base, "adapted": adapt, "loss": hist, "errors": errors, "params": params, "classes": use}
    experiment.save_extra("m1", res)
    j.ok(f"F1-macro {base['f1_macro']:.3f} → {adapt['f1_macro']:.3f} · помилок на тесті: {len(errors)}")
    return res


if __name__ == "__main__":
    from core.jobs import NullJob
    r = run_experiment(job=NullJob(verbose=True))
    print("baseline", r["baseline"]["f1_macro"], "adapted", r["adapted"]["f1_macro"])
