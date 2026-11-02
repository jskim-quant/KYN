"""
자산 모델 (스펙 1.3) + 평가가액 병렬 보관 (스펙 2).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AssetType(str, Enum):
    CASH = "CASH"
    DEPOSIT = "DEPOSIT"
    SECURITY = "SECURITY"
    LAND = "LAND"
    HOUSE = "HOUSE"
    COMMERCIAL_BUILDING = "COMMERCIAL_BUILDING"
    OFFICETEL = "OFFICETEL"
    FACTORY = "FACTORY"
    FARMLAND = "FARMLAND"
    FOREST = "FOREST"
    REDEVELOPMENT_RIGHT = "REDEVELOPMENT_RIGHT"
    UNLISTED_SHARE = "UNLISTED_SHARE"
    LISTED_SHARE = "LISTED_SHARE"
    CORPORATE_SHARE = "CORPORATE_SHARE"
    INSURANCE = "INSURANCE"
    RECEIVABLE = "RECEIVABLE"
    INTELLECTUAL_PROPERTY = "INTELLECTUAL_PROPERTY"
    OTHER = "OTHER"


class RentalProfile(BaseModel):
    annual_rent: Decimal = Decimal("0")
    vacancy_rate_pct: float = 0.0
    maintenance_cost: Decimal = Decimal("0")
    lease_expiry: Optional[date] = None


class LiquidityProfile(BaseModel):
    liquidity_tier: str = "illiquid"  # "cash_equivalent" | "liquid" | "semi_liquid" | "illiquid"
    estimated_days_to_sell: Optional[int] = None
    sale_cost_pct: float = 0.0  # 중개수수료 등


class AssetTaxAttributes(BaseModel):
    house_count_for_owner: Optional[int] = None
    is_regulated_area: bool = False
    is_one_house_one_family: bool = False
    is_corp_owned: bool = False


class AppraisalRecord(BaseModel):
    appraiser: str
    appraisal_date: date
    value: Decimal
    purpose: str  # "loan" | "gift_tax" | "inheritance_tax" | "litigation" | ...
    is_formal: bool = True  # 정식 감정평가 vs 은행 내부평가


class ValuationSet(BaseModel):
    official_value: Optional[Decimal] = None            # 공시가격
    supplementary_value: Optional[Decimal] = None        # 보충적 평가액
    comparable_transaction_value: Optional[Decimal] = None
    auction_value: Optional[Decimal] = None
    public_sale_value: Optional[Decimal] = None
    appraisal_values: list[AppraisalRecord] = Field(default_factory=list)
    bank_internal_value: Optional[Decimal] = None
    user_estimate: Optional[Decimal] = None

    selected_tax_value: Optional[Decimal] = None
    selected_tax_value_reason: Optional[str] = None
    confidence: float = Field(default=0.5, ge=0, le=1)
    requires_expert_review: bool = True


class Asset(BaseModel):
    id: str
    owner_id: str
    ownership_ratio: float = Field(default=1.0, ge=0, le=1)
    asset_type: AssetType

    location_country: str = "KR"
    address: Optional[str] = None
    acquisition_date: date
    acquisition_method: str = "purchase"  # "purchase" | "gift" | "inheritance"
    acquisition_cost: Decimal
    documented_acquisition_cost: Optional[Decimal] = None

    book_value: Optional[Decimal] = None
    valuation: ValuationSet = Field(default_factory=ValuationSet)

    rental_profile: Optional[RentalProfile] = None
    debt_ids: list[str] = Field(default_factory=list)
    legal_restrictions: list[str] = Field(default_factory=list)
    liquidity_profile: LiquidityProfile = Field(default_factory=LiquidityProfile)
    tax_attributes: AssetTaxAttributes = Field(default_factory=AssetTaxAttributes)

    @property
    def current_market_value(self) -> Decimal:
        """세무상 시가 우선순위: 매매사례 > 감정가 > 경매/공매 > 사용자추정 > 공시가."""
        v = self.valuation
        if v.selected_tax_value is not None:
            return v.selected_tax_value
        if v.comparable_transaction_value is not None:
            return v.comparable_transaction_value
        if v.appraisal_values:
            return max(a.value for a in v.appraisal_values)
        if v.auction_value is not None:
            return v.auction_value
        if v.public_sale_value is not None:
            return v.public_sale_value
        if v.user_estimate is not None:
            return v.user_estimate
        if v.official_value is not None:
            return v.official_value
        return self.book_value or Decimal("0")
