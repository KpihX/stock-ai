"""Typed contracts for the API. Field names match config.jsonc and the Mermaid graph."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class OrderLine(BaseModel):
    command_id: str
    product_id: str
    client_id: str
    recorded_at: datetime
    delivery_date: datetime
    price: float
    quantity: float


class Command(BaseModel):
    command_id: str
    client_id: str
    client_name: str = ""
    client_phone: str = ""
    client_order_count: int = 1
    recorded_at: datetime
    delivery_date: datetime
    price: float
    quantity: float
    product_id: str
    product_name: str = ""
    status: str = "new"
    summary: str = ""
    decision_comment: str = ""
    decided_by: str = ""
    decided_at: datetime | None = None


class CommandDetail(BaseModel):
    command: Command
    order_lines: list[OrderLine]
    normalized_input: dict | None = None


class ClientStats(BaseModel):
    client_id: str
    client_name: str
    phone_number: str
    order_count: int = 0
    last_order_lines: list[OrderLine] = Field(default_factory=list)
    usual_lines: list[OrderLine] = Field(default_factory=list)


class Product(BaseModel):
    product_id: str
    product_name: str
    price: float
    stock: float


class Purchase(BaseModel):
    purchase_id: str
    product_id: str
    quantity: float
    price: float
    status: str = "proposition"
    decision: str = "jev"


class Signal(BaseModel):
    evenement_id: str
    capture_le: datetime
    canal: str
    actor_ref: str
    modality: str
    texte: str = ""
    cNumber: str = ""
    message_id: str = ""
    media_path: str = ""


class EnrichedData(BaseModel):
    client_id: str
    cNumber: str
    client_stats: ClientStats
    products: list[Product] = Field(default_factory=list)
    open_commands: list[dict] = Field(default_factory=list)
    signal: Signal
    is_new_client: bool = False


class NormalizedInput(BaseModel):
    summary: str
    past_orders: list[Command] = Field(default_factory=list)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    token: str
    role: str = "manager"


class ApproveRequest(BaseModel):
    approve: bool
    comment: str = ""
