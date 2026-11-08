"""Pydantic-моделі: фільтри запитів і основні відповіді."""
from datetime import date, timedelta

from pydantic import BaseModel, Field


class Filters(BaseModel):
    date_from: date
    date_to: date
    oblast: list[str] = Field(default_factory=list)      # ISO 3166-2, напр. UA-63
    unit: list[int] = Field(default_factory=list)
    weapon: list[str] = Field(default_factory=list)
    system: list[str] = Field(default_factory=list)
    direction: list[str] = Field(default_factory=list)
    cause: list[str] = Field(default_factory=list)
    urgency: list[str] = Field(default_factory=list)
    doc_type: list[str] = Field(default_factory=list)

    @property
    def days(self) -> int:
        return (self.date_to - self.date_from).days + 1

    def previous(self) -> "Filters":
        """Попередній період такої самої довжини (для зміни KPI)."""
        return self.model_copy(update={"date_from": self.date_from - timedelta(days=self.days),
                                       "date_to": self.date_from - timedelta(days=1)})

    def last_days(self, n: int) -> "Filters":
        return self.model_copy(update={"date_from": self.date_to - timedelta(days=n - 1)})


class Health(BaseModel):
    status: str
    db: str
    synthetic: bool = True


class Kpi(BaseModel):
    key: str
    module: str
    label: str
    value: float | None
    unit: str
    previous: float | None = None
    delta_pct: float | None = None
    better: str = Field("down", description="'up' — краще, коли зростає; 'down' — коли спадає")
    note: str | None = None


class KpiResponse(BaseModel):
    module: str
    date_from: date
    date_to: date
    items: list[Kpi]
