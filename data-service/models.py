from pydantic import BaseModel
from typing import Optional


class Measurement(BaseModel):
    id: int
    date: str
    time: str
    sender_id: str
    sender_name: str
    sender_lat: float
    sender_lon: float
    rx_lat: float
    rx_lon: float
    rx_elevation: Optional[int] = None
    rx_snr: float
    distance_m: Optional[int] = None
    hop_limit: Optional[int] = None
    payload: Optional[str] = None
    hidden: bool = False


class MeasurementPatch(BaseModel):
    hidden: bool


class ImportResult(BaseModel):
    inserted: int
    skipped: int
    total: int
