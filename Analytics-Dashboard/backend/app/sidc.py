"""Коди знаків (MIL-STD-2525C, 15 символів) для milsymbol. Правила кольору/накладань — у frontend/src/symbols.js."""

ART_FN = {  # система → функція обладнання; останній символ: клас калібру (L/M/H)
    "mortar": "EWO{c}--", "howitzer": "EWH{c}--", "gun": "EWG{c}--", "mlrs": "EWR{c}--", "tank": "EVAT{c}-",
}
CLS = {"light": "L", "medium": "M", "heavy": "H"}


def artillery_sidc(system: str, caliber_class: str) -> str:
    """Засіб противника (ворожий, наземне обладнання)."""
    return "SHGP" + ART_FN[system].format(c=CLS[caliber_class]) + "-----"


# Свої підрозділи (дружні, наземні): функція 2525C + ешелон (табл. 8 Порядку)
ECHELON_CHAR = {"company": "E", "battalion": "F", "regiment": "G", "brigade": "H", "division": "I",
                "corps": "J", "army": "K", "command": "K", "unknown": "-"}
BRANCH_FN = {
    "mech": "UCIZ--", "tank": "UCA---", "artillery": "UCF---", "air_defense": "UCD---",
    "airborne": "UCIA--", "support": "USS---", "hq": "UH----", "recon": "UCR---", "marine": "UCIN--",
    "infantry": "UCI---", "engineer": "UCE---",
    "training": "UCI---", "signal": "UUS---", "maintenance": "USX---", "medical": "USM---",
}


def unit_sidc(branch: str, echelon: str, hostile: bool = False) -> str:
    hq = "A" if branch == "hq" else "-"
    return f"S{'H' if hostile else 'F'}GP{BRANCH_FN[branch]}{hq}{ECHELON_CHAR[echelon]}---"


def caliber_class(system: str, mm: int) -> str:
    """Клас калібру за табл. 16 Порядку."""
    if system == "mortar":
        return "light" if mm < 60 else "medium" if mm <= 107 else "heavy"
    if system == "mlrs":
        return "light" if mm < 100 else "medium" if mm < 200 else "heavy"
    return "light" if mm < 120 else "medium" if mm <= 160 else "heavy"
