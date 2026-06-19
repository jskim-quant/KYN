export const RECOVERY_SCENARIO_STORAGE_KEY = 'kyn_recovery_scenario_v2';
export const RECOVERY_SCENARIO_LIST_STORAGE_KEY = 'kyn_recovery_scenarios_v1';
export const CUSTOM_SCENARIO_STORAGE_KEY = 'kyn_custom_scenario_v1';
export const CUSTOM_SCENARIO_LIST_STORAGE_KEY = 'kyn_custom_scenarios_v1';
const LEGACY_RECOVERY_PLAN_STORAGE_KEY = 'kyn_recovery_plan';

export type SavedScenarioType =
  | '현금흐름형'
  | '절세형'
  | '균형형'
  | '회생형'
  | '공익형'
  | '법인형';

export const SAVED_SCENARIO_TYPES: SavedScenarioType[] = [
  '현금흐름형',
  '절세형',
  '균형형',
  '회생형',
  '공익형',
  '법인형',
];

export interface SavedRecoveryScenarioConfig {
  version: 2;
  selectedStrategyIds: string[];
  giftNowPct: number;
  foundationAssetId: string;
  foundationDonationPct: number;
  scenarioType?: SavedScenarioType;
  savedAt: string;
}

export interface SavedRecoveryScenarioItem extends SavedRecoveryScenarioConfig {
  id: string;
  name: string;
}

const DEFAULT_CONFIG: SavedRecoveryScenarioConfig = {
  version: 2,
  selectedStrategyIds: [],
  giftNowPct: 0,
  foundationAssetId: '',
  foundationDonationPct: 30,
  scenarioType: '회생형',
  savedAt: '',
};

export interface SavedCustomScenarioConfig {
  version: 4;
  giftNowPct: number;
  useCorp: boolean;
  ceoSalary: number;
  includeGrandchildren: boolean;
  useFoundation: boolean;
  foundationDonationPct: number;
  corpContributionPct: number;
  loanLtvPct: number;
  assetLtvMap: Record<string, number>;
  assetInterestRateMap: Record<string, number>;
  rateShockPct: number;
  scenarioType?: SavedScenarioType;
  savedAt: string;
}

export interface SavedCustomScenarioItem extends SavedCustomScenarioConfig {
  id: string;
  name: string;
}

const DEFAULT_CUSTOM_CONFIG: SavedCustomScenarioConfig = {
  version: 4,
  giftNowPct: 30,
  useCorp: false,
  ceoSalary: 0.3,
  includeGrandchildren: false,
  useFoundation: false,
  foundationDonationPct: 10,
  corpContributionPct: 50,
  loanLtvPct: 0,
  assetLtvMap: {},
  assetInterestRateMap: {},
  rateShockPct: 1.5,
  scenarioType: '균형형',
  savedAt: '',
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeStrategyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string')));
}

function normalizeLtvMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([assetId]) => assetId.length > 0)
      .map(([assetId, pct]) => [assetId, boundedNumber(pct, 0, 0, 80)])
  );
}

function normalizeInterestRateMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([assetId]) => assetId.length > 0)
      .map(([assetId, rate]) => [assetId, boundedNumber(rate, 0, 0, 20)])
  );
}

function normalizeCustomScenarioConfig(
  value: Partial<SavedCustomScenarioConfig> | Omit<SavedCustomScenarioConfig, 'version' | 'savedAt'>,
  savedAt = '',
): SavedCustomScenarioConfig {
  const parsedSavedAt = 'savedAt' in value && typeof value.savedAt === 'string' ? value.savedAt : savedAt;
  return {
    version: 4,
    giftNowPct: boundedNumber(value.giftNowPct, DEFAULT_CUSTOM_CONFIG.giftNowPct, 0, 100),
    useCorp: Boolean(value.useCorp),
    ceoSalary: boundedNumber(value.ceoSalary, DEFAULT_CUSTOM_CONFIG.ceoSalary, 0, 10),
    includeGrandchildren: Boolean(value.includeGrandchildren),
    useFoundation: Boolean(value.useFoundation),
    foundationDonationPct: boundedNumber(value.foundationDonationPct, DEFAULT_CUSTOM_CONFIG.foundationDonationPct, 0, 100),
    corpContributionPct: boundedNumber(value.corpContributionPct, DEFAULT_CUSTOM_CONFIG.corpContributionPct, 0, 100),
    loanLtvPct: boundedNumber(value.loanLtvPct, DEFAULT_CUSTOM_CONFIG.loanLtvPct, 0, 80),
    assetLtvMap: normalizeLtvMap(value.assetLtvMap),
    assetInterestRateMap: normalizeInterestRateMap(value.assetInterestRateMap),
    rateShockPct: boundedNumber(value.rateShockPct, DEFAULT_CUSTOM_CONFIG.rateShockPct, 0, 8),
    scenarioType: normalizeScenarioType(value.scenarioType, DEFAULT_CUSTOM_CONFIG.scenarioType),
    savedAt: parsedSavedAt,
  };
}

function normalizeScenarioType(value: unknown, fallback: SavedScenarioType = '균형형'): SavedScenarioType {
  if (value === '레버리지형') return '현금흐름형';
  if (value === '성장형') return '균형형';
  return typeof value === 'string' && SAVED_SCENARIO_TYPES.includes(value as SavedScenarioType)
    ? value as SavedScenarioType
    : fallback;
}

function makeTypedDefaultName<T extends { scenarioType?: SavedScenarioType }>(
  list: T[],
  scenarioType: SavedScenarioType,
) {
  const sameTypeCount = list.filter(item => item.scenarioType === scenarioType).length;
  return `${scenarioType} ${sameTypeCount + 1}`;
}

function normalizeCustomScenarioItem(value: unknown, index: number): SavedCustomScenarioItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<SavedCustomScenarioItem>;
  const savedAt = typeof parsed.savedAt === 'string' && parsed.savedAt ? parsed.savedAt : new Date().toISOString();
  const rawName = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim().slice(0, 30)
    : `설계안 ${index + 1}`;
  const normalizedName = rawName.replace(/^커스텀/, '설계안');
  return {
    ...normalizeCustomScenarioConfig(parsed, savedAt),
    id: typeof parsed.id === 'string' && parsed.id ? parsed.id : `custom-${savedAt}-${index}`,
    name: normalizedName,
    savedAt,
  };
}

function makeCustomScenarioId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRecoveryScenarioId() {
  return `recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRecoveryScenarioConfig(
  value: Partial<SavedRecoveryScenarioConfig> | Omit<SavedRecoveryScenarioConfig, 'version' | 'savedAt'>,
  savedAt = '',
): SavedRecoveryScenarioConfig {
  const parsedSavedAt = 'savedAt' in value && typeof value.savedAt === 'string' ? value.savedAt : savedAt;
  return {
    version: 2,
    selectedStrategyIds: normalizeStrategyIds(value.selectedStrategyIds),
    giftNowPct: boundedNumber(value.giftNowPct, DEFAULT_CONFIG.giftNowPct, 0, 100),
    foundationAssetId: typeof value.foundationAssetId === 'string' ? value.foundationAssetId : '',
    foundationDonationPct: boundedNumber(value.foundationDonationPct, DEFAULT_CONFIG.foundationDonationPct, 0, 100),
    scenarioType: normalizeScenarioType(value.scenarioType, '회생형'),
    savedAt: parsedSavedAt,
  };
}

function normalizeRecoveryScenarioItem(value: unknown, index: number): SavedRecoveryScenarioItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<SavedRecoveryScenarioItem>;
  const savedAt = typeof parsed.savedAt === 'string' && parsed.savedAt ? parsed.savedAt : new Date().toISOString();
  const rawName = typeof parsed.name === 'string' && parsed.name.trim()
    ? parsed.name.trim().slice(0, 30)
    : `회생안 ${index + 1}`;
  const normalizedName = rawName.replace(/^저장한 전략/, '회생안').replace(/^전략안/, '회생안');
  return {
    ...normalizeRecoveryScenarioConfig(parsed, savedAt),
    id: typeof parsed.id === 'string' && parsed.id ? parsed.id : `recovery-${savedAt}-${index}`,
    name: normalizedName,
    savedAt,
  };
}

export function loadSavedRecoveryScenario(): SavedRecoveryScenarioConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;

  try {
    const saved = localStorage.getItem(RECOVERY_SCENARIO_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<SavedRecoveryScenarioConfig>;
      return {
        version: 2,
        selectedStrategyIds: normalizeStrategyIds(parsed.selectedStrategyIds),
        giftNowPct: boundedNumber(parsed.giftNowPct, DEFAULT_CONFIG.giftNowPct, 0, 100),
        foundationAssetId: typeof parsed.foundationAssetId === 'string' ? parsed.foundationAssetId : '',
        foundationDonationPct: boundedNumber(parsed.foundationDonationPct, DEFAULT_CONFIG.foundationDonationPct, 0, 100),
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      };
    }

    const legacy = localStorage.getItem(LEGACY_RECOVERY_PLAN_STORAGE_KEY);
    return {
      ...DEFAULT_CONFIG,
      selectedStrategyIds: normalizeStrategyIds(JSON.parse(legacy || '[]')),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function loadSavedRecoveryScenarios(): SavedRecoveryScenarioItem[] {
  if (typeof window === 'undefined') return [];

  try {
    const savedList = localStorage.getItem(RECOVERY_SCENARIO_LIST_STORAGE_KEY);
    if (savedList) {
      const parsed = JSON.parse(savedList);
      if (Array.isArray(parsed)) {
        return parsed
          .map(normalizeRecoveryScenarioItem)
          .filter((item): item is SavedRecoveryScenarioItem => Boolean(item))
          .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      }
    }

    const legacy = loadSavedRecoveryScenario();
    if (!legacy.savedAt || legacy.selectedStrategyIds.length === 0) return [];
    return [{
      ...legacy,
      id: `legacy-${legacy.savedAt}`,
      name: '회생안 1',
    }];
  } catch {
    return [];
  }
}

export function saveRecoveryScenario(
  config: Omit<SavedRecoveryScenarioConfig, 'version' | 'savedAt'>,
): SavedRecoveryScenarioConfig {
  const normalized = normalizeRecoveryScenarioConfig(config, new Date().toISOString());

  localStorage.setItem(RECOVERY_SCENARIO_STORAGE_KEY, JSON.stringify(normalized));
  localStorage.setItem(LEGACY_RECOVERY_PLAN_STORAGE_KEY, JSON.stringify(normalized.selectedStrategyIds));
  return normalized;
}

export function saveRecoveryScenarioItem(
  config: Omit<SavedRecoveryScenarioConfig, 'version' | 'savedAt'>,
  name?: string,
): SavedRecoveryScenarioItem {
  if (typeof window === 'undefined') {
    return {
      ...normalizeRecoveryScenarioConfig(config, new Date().toISOString()),
      id: makeRecoveryScenarioId(),
      name: name || '회생안',
    };
  }

  const list = loadSavedRecoveryScenarios();
  const normalized = saveRecoveryScenario(config);
  const scenarioType = normalized.scenarioType ?? '회생형';
  const item: SavedRecoveryScenarioItem = {
    ...normalized,
    id: makeRecoveryScenarioId(),
    name: (name || makeTypedDefaultName(list, scenarioType))
      .trim()
      .replace(/^저장한 전략/, scenarioType)
      .replace(/^전략안/, scenarioType)
      .replace(/^시나리오\s*\d*$/, makeTypedDefaultName(list, scenarioType))
      .slice(0, 30),
  };
  const next = [...list, item].slice(-12);
  localStorage.setItem(RECOVERY_SCENARIO_LIST_STORAGE_KEY, JSON.stringify(next));
  return item;
}

export function deleteSavedRecoveryScenario(id: string) {
  if (typeof window === 'undefined') return;
  const next = loadSavedRecoveryScenarios().filter(item => item.id !== id);
  localStorage.setItem(RECOVERY_SCENARIO_LIST_STORAGE_KEY, JSON.stringify(next));
  if (next.length === 0) {
    localStorage.removeItem(RECOVERY_SCENARIO_STORAGE_KEY);
    localStorage.removeItem(LEGACY_RECOVERY_PLAN_STORAGE_KEY);
  } else {
    const { id: _id, name: _name, ...latest } = next[next.length - 1];
    localStorage.setItem(RECOVERY_SCENARIO_STORAGE_KEY, JSON.stringify(latest));
    localStorage.setItem(LEGACY_RECOVERY_PLAN_STORAGE_KEY, JSON.stringify(latest.selectedStrategyIds));
  }
}

export function updateSavedRecoveryScenarioType(id: string, scenarioType: SavedScenarioType) {
  if (typeof window === 'undefined') return;
  const next = loadSavedRecoveryScenarios().map(item => (
    item.id === id ? { ...item, scenarioType: normalizeScenarioType(scenarioType, item.scenarioType) } : item
  ));
  localStorage.setItem(RECOVERY_SCENARIO_LIST_STORAGE_KEY, JSON.stringify(next));
  const latest = next[next.length - 1];
  if (latest) {
    const { id: _id, name: _name, ...latestConfig } = latest;
    localStorage.setItem(RECOVERY_SCENARIO_STORAGE_KEY, JSON.stringify(latestConfig));
    localStorage.setItem(LEGACY_RECOVERY_PLAN_STORAGE_KEY, JSON.stringify(latestConfig.selectedStrategyIds));
  }
}

export function clearSavedRecoveryScenario() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(RECOVERY_SCENARIO_STORAGE_KEY);
  localStorage.removeItem(RECOVERY_SCENARIO_LIST_STORAGE_KEY);
  localStorage.removeItem(LEGACY_RECOVERY_PLAN_STORAGE_KEY);
}

export function loadSavedCustomScenario(): SavedCustomScenarioConfig {
  if (typeof window === 'undefined') return DEFAULT_CUSTOM_CONFIG;

  try {
    const saved = localStorage.getItem(CUSTOM_SCENARIO_STORAGE_KEY);
    if (!saved) return DEFAULT_CUSTOM_CONFIG;
    const parsed = JSON.parse(saved) as Partial<SavedCustomScenarioConfig>;
    return normalizeCustomScenarioConfig(parsed);
  } catch {
    return DEFAULT_CUSTOM_CONFIG;
  }
}

export function loadSavedCustomScenarios(): SavedCustomScenarioItem[] {
  if (typeof window === 'undefined') return [];

  try {
    const savedList = localStorage.getItem(CUSTOM_SCENARIO_LIST_STORAGE_KEY);
    if (savedList) {
      const parsed = JSON.parse(savedList);
      if (Array.isArray(parsed)) {
        return parsed
          .map(normalizeCustomScenarioItem)
          .filter((item): item is SavedCustomScenarioItem => Boolean(item))
          .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      }
    }

    const legacy = loadSavedCustomScenario();
    if (!legacy.savedAt) return [];
    return [{
      ...legacy,
      id: `legacy-${legacy.savedAt}`,
      name: '설계안 1',
    }];
  } catch {
    return [];
  }
}

export function saveCustomScenario(
  config: Omit<SavedCustomScenarioConfig, 'version' | 'savedAt'>,
): SavedCustomScenarioConfig {
  const normalized = normalizeCustomScenarioConfig(config, new Date().toISOString());

  localStorage.setItem(CUSTOM_SCENARIO_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function saveCustomScenarioItem(
  config: Omit<SavedCustomScenarioConfig, 'version' | 'savedAt'>,
  name?: string,
): SavedCustomScenarioItem {
  if (typeof window === 'undefined') {
    return {
      ...normalizeCustomScenarioConfig(config, new Date().toISOString()),
      id: makeCustomScenarioId(),
      name: name || '설계안',
    };
  }

  const list = loadSavedCustomScenarios();
  const normalized = saveCustomScenario(config);
  const scenarioType = normalized.scenarioType ?? '균형형';
  const item: SavedCustomScenarioItem = {
    ...normalized,
    id: makeCustomScenarioId(),
    name: (name || makeTypedDefaultName(list, scenarioType))
      .trim()
      .replace(/^커스텀/, scenarioType)
      .replace(/^설계안/, scenarioType)
      .replace(/^시나리오\s*\d*$/, makeTypedDefaultName(list, scenarioType))
      .slice(0, 30),
  };
  const next = [...list, item].slice(-12);
  localStorage.setItem(CUSTOM_SCENARIO_LIST_STORAGE_KEY, JSON.stringify(next));
  return item;
}

export function updateSavedCustomScenarioType(id: string, scenarioType: SavedScenarioType) {
  if (typeof window === 'undefined') return;
  const next = loadSavedCustomScenarios().map(item => (
    item.id === id ? { ...item, scenarioType: normalizeScenarioType(scenarioType, item.scenarioType) } : item
  ));
  localStorage.setItem(CUSTOM_SCENARIO_LIST_STORAGE_KEY, JSON.stringify(next));
  const latest = next[next.length - 1];
  if (latest) {
    const { id: _id, name: _name, ...latestConfig } = latest;
    localStorage.setItem(CUSTOM_SCENARIO_STORAGE_KEY, JSON.stringify(latestConfig));
  }
}

export function deleteSavedCustomScenario(id: string) {
  if (typeof window === 'undefined') return;
  const next = loadSavedCustomScenarios().filter(item => item.id !== id);
  localStorage.setItem(CUSTOM_SCENARIO_LIST_STORAGE_KEY, JSON.stringify(next));
  if (next.length === 0) {
    localStorage.removeItem(CUSTOM_SCENARIO_STORAGE_KEY);
  } else {
    const { id: _id, name: _name, ...latest } = next[next.length - 1];
    localStorage.setItem(CUSTOM_SCENARIO_STORAGE_KEY, JSON.stringify(latest));
  }
}

export function clearSavedCustomScenario() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(CUSTOM_SCENARIO_STORAGE_KEY);
  localStorage.removeItem(CUSTOM_SCENARIO_LIST_STORAGE_KEY);
}
