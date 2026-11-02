export type RuleStatus =
  | 'SUPPORTED'
  | 'SUPPORTED_WITH_CONDITIONS'
  | 'DISPUTED'
  | 'OUTDATED'
  | 'UNSUPPORTED'
  | 'UNVERIFIED';

export type SourceType = 'statute' | 'decree' | 'nts_interpretation' | 'tribunal' | 'court' | 'law_firm' | 'practitioner' | 'press';

export interface RuleSource {
  type: SourceType;
  ref: string;
  url?: string;
  accessedOn: string; // YYYY-MM-DD
}

/** 구현된 세법 규칙의 메타데이터. UNVERIFIED 규칙은 레지스트리에 들어올 수 없다. */
export interface TaxRuleMeta {
  ruleId: string;
  taxType: 'GiftTax' | 'InheritanceTax' | 'CapitalGainsTax' | 'CorporateIncomeTax';
  title: string;
  legalBasis: string[];
  /** 시행일(YYYY-MM-DD). 확인하지 못했으면 null이며 openIssues에 이유를 적어야 한다. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  lastVerified: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  status: Exclude<RuleStatus, 'UNVERIFIED'>;
  implementedIn: string;
  sources: RuleSource[];
  openIssues: string[];
}
