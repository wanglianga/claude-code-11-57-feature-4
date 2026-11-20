// 领域类型定义：所有时间统一使用 UTC ISO8601 字符串，内部计算单位统一为
// 水量 m³、流量 m³/s、水位 m、面积 m²、雨量/蒸发 mm。

export type ID = string;
export type ISOTime = string;

/** 质量标志：confirmed 已确认；estimated 估算可用；suspect 可疑；missing 显式缺失；rejected 作废 */
export type QualityFlag = 'confirmed' | 'estimated' | 'suspect' | 'missing' | 'rejected';

export type ReadingKind =
  | 'rainfall' // 雨量（区间累计，mm）
  | 'water_level' // 库水位（m）
  | 'inflow' // 入库流量（m³/s）
  | 'outflow' // 出库流量（m³/s）
  | 'gate_opening' // 闸门开度
  | 'gate_order' // 闸门指令
  | 'evaporation' // 蒸发（区间累计，mm）
  | 'diversion_in' // 跨库调入（m³/s）
  | 'diversion_out'; // 跨库调出（m³/s）

export interface RawReading {
  id: ID;
  reservoirId?: ID;
  stationId?: ID;
  zoneId?: ID;
  kind: ReadingKind;
  /** 采样时间；区间累计类为区间结束时刻 */
  sampledAt: ISOTime;
  /** 接收时间：迟到判定与资料截止点过滤依据 */
  receivedAt: ISOTime;
  /** 区间累计类（雨量/蒸发）的区间起点 */
  intervalStart?: ISOTime;
  /** 显式缺失记为 null，绝不以 0 补齐 */
  value: number | null;
  unit: string;
  quality: QualityFlag;
  sourceFile: string;
  /** 修订关系：本读数修订哪一条原始读数 */
  revisionOf?: ID;
  /** 被哪一条修订替代（物化在被替代记录上） */
  supersededById?: ID;
  /** 仪器额定不确定度（同 unit），缺失时用于未知范围估算 */
  uncertainty?: number;
  note?: string;
  createdAt: ISOTime;
}

export interface RainZone {
  id: ID;
  name: string;
}

export interface RainStation {
  id: ID;
  name: ID;
  zoneId: ID;
  lon: number;
  lat: number;
}

export interface Reservoir {
  id: ID;
  name: string;
  lon: number;
  lat: number;
  /** 面雨量分区权重，权重之和应为 1 */
  rainWeights: { zoneId: ID; weight: number }[];
}

export type CurveKind = 'storage' | 'area';
export type ApprovalStatus = 'draft' | 'approved' | 'retired';

export interface CurvePoint {
  x: number; // 水位 m
  y: number; // storage: 蓄水量（按 storageUnit）；area: 库面面积（按 areaUnit）
}

export interface CurveVersion {
  id: ID;
  reservoirId: ID;
  kind: CurveKind;
  version: string;
  validFrom: ISOTime;
  validTo?: ISOTime; // 空表示至今
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  points: CurvePoint[];
  /** storage 曲线点单位：m3 或 万m3；area 曲线点单位：m2 或 km2 */
  pointUnit: 'm3' | 'wan_m3' | 'm2' | 'km2';
  note?: string;
}

export interface DispatchRule {
  id: ID;
  reservoirId: ID;
  version: string;
  validFrom: ISOTime;
  validTo?: ISOTime;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  /** 汛限库容 m³ */
  floodLimitStorage: number;
  /** 规则目标库容 m³（泄洪空间回算目标） */
  targetStorage: number;
  /** 下游允许泄流范围 m³/s */
  downstreamMinRelease: number;
  downstreamMaxRelease: number;
  note?: string;
}

export type RunStatus = 'running' | 'completed' | 'completed_with_warnings' | 'failed';
export type RunDesign = 'materialized' | 'on_demand';

export interface RunTolerance {
  /** 绝对容差 m³ */
  absM3: number;
  /** 相对容差（占蓄变与各项绝对值均值的比例） */
  relFraction: number;
}

export interface BalanceRun {
  id: ID;
  name: string;
  /** 资料截止点：仅纳入 receivedAt <= cutoff 的读数 */
  cutoffAt: ISOTime;
  gridStart: ISOTime;
  gridEnd: ISOTime;
  /** 时间网格步长（秒） */
  gridStepSeconds: number;
  tolerance: RunTolerance;
  /** 近期来水压力窗口（秒） */
  pressureWindowSeconds: number;
  /** 下一决策时点距离（秒） */
  decisionHorizonSeconds: number;
  reservoirIds: ID[];
  status: RunStatus;
  design: RunDesign;
  createdAt: ISOTime;
  finishedAt?: ISOTime;
  warnings: string[];
  stats?: { factCount: number; pendingCount: number; unclosedCount: number };
}

/** 运行输入快照：运行时固定的一组来源、曲线版本、规则，保证可复算 */
export interface RunSnapshot {
  runId: ID;
  readings: RawReading[];
  curves: CurveVersion[];
  rules: DispatchRule[];
  reservoirs: Reservoir[];
  zones: RainZone[];
  /** 断面风险推导主数据（断面/健康记录/水文关系/支流/条件模型），随快照冻结 */
  riverSections: RiverSection[];
  healthRecords: StationHealthRecord[];
  hydrologicRelations: HydrologicRelation[];
  tributaryConditions: TributaryCondition[];
  conditionalRelations: ConditionalRelation[];
  frozenAt: ISOTime;
}

export interface BalanceTerm {
  key: 'inflow' | 'outflow' | 'rainfall' | 'evaporation' | 'transferIn' | 'transferOut';
  label: string;
  /** 折算出的区间水量 m³；覆盖不足为 null */
  valueM3: number | null;
  covered: boolean;
  sourceReadingIds: ID[];
  /** 该项未知量的可能范围 m³（仅未覆盖/可疑时非零） */
  unknownRangeM3: [number, number];
  detail?: string;
}

export interface BalanceFact {
  id: ID;
  runId: ID;
  reservoirId: ID;
  t1: ISOTime;
  t2: ISOTime;
  durationSeconds: number;
  s1: number | null;
  s2: number | null;
  storageCurveIdAtT1?: ID;
  storageCurveIdAtT2?: ID;
  areaCurveId?: ID;
  curveSwitched: boolean;
  terms: BalanceTerm[];
  /** ΔS = S2-S1 m³ */
  deltaS: number | null;
  /** 可确认平衡项合计（方程括号内部分），m³ */
  confirmedNet: number | null;
  /** 残差 R = ΔS - 平衡项合计；任一关键项未覆盖则为 null */
  residual: number | null;
  closed: boolean;
  toleranceM3: number;
  unclosedReasons: string[];
  /** 整个区间未知量的可能范围 m³ */
  unknownRangeM3: [number, number];
}

export type IndicatorStatus = 'ok' | 'warn' | 'pending';

export interface ReservoirIndicator {
  id: ID;
  runId: ID;
  reservoirId: ID;
  asOf: ISOTime;
  currentStorage: number | null;
  floodLimitStorage: number | null;
  ruleId?: ID;
  /** 防洪余量 = 汛限库容 - 已确认蓄水量 m³ */
  floodMargin: number | null;
  marginStatus: IndicatorStatus;
  windowSeconds: number;
  /** 窗口内可确认净入库量 m³ */
  netInflowConfirmed: number | null;
  /** 净入库未知范围 m³ */
  netInflowUnknownRange: [number, number] | null;
  /** 来水压力比 = 可确认净入库 / 防洪余量 */
  pressureRatio: number | null;
  /** 计入未知范围后的压力比区间 */
  pressureRatioRange: [number | null, number | null];
  /** 回到目标库容所需出库流量范围 m³/s */
  releaseNeededRange: [number | null, number | null] | null;
  downstreamAllowableRange: [number, number] | null;
  /** 所需出库与下游允许范围的差额 m³/s（正值表示允许泄流不足） */
  releaseGapRange: [number | null, number | null] | null;
  pending: boolean;
  pendingReasons: string[];
  factIds: ID[];
}

export interface AnnotationField {
  field: string;
  author: string;
  value: string;
  updatedAt: ISOTime;
}

export interface Annotation {
  id: ID;
  subjectType: 'indicator' | 'fact' | 'reading' | 'rule' | 'curve';
  subjectId: ID;
  /** 字段级批注：两个页面并发修改不同字段时各自保留，不做整单覆盖 */
  fields: Record<string, AnnotationField>;
  revision: number;
  updatedAt: ISOTime;
}

export interface SourceFileRecord {
  id: ID;
  fileName: string;
  kind: ReadingKind | 'mixed';
  importedAt: ISOTime;
  readingCount: number;
  byteSize: number;
  note?: string;
}

// ===================================================================
// 下游断面风险范围推导（传感器故障期间不替代实测，只输出风险时间段）
// 所有推导结果一律标注为 inferred，绝不产出单一“替代水位/流量”。
// ===================================================================

/** 承压线判定基准类型：水位 m 或流量 m³/s */
export type SectionMetricKind = 'water_level' | 'flow';

/** 河道断面（下游承压线载体，区别于水库入库/出库断面） */
export interface RiverSection {
  id: ID;
  name: string;
  lon: number;
  lat: number;
  metric: SectionMetricKind;
  unit: string;
  /** 河道承压线：超过即超限 */
  bearingLimit: number;
  /** 预警线（低于承压线），用于建议分级，不改变四类判定 */
  warningLimit: number;
}

/** 站点校准状态：未校准/校准时段的传播界额外加宽 */
export type CalibrationStatus = 'calibrated' | 'due' | 'uncalibrated';

/** 站点健康记录：故障区间显式登记，区别于“没有读数” */
export interface StationHealthRecord {
  id: ID;
  sectionId: ID;
  /** 故障开始（含） */
  faultStart: ISOTime;
  /** 故障结束（含）；undefined 表示截至运行截止点仍未恢复 */
  faultEnd?: ISOTime;
  reason: string;
  calibration: CalibrationStatus;
  /** 该故障区间内仍可用的邻近断面（候选参考站，须另有水文关系支撑才可用） */
  availableNeighborIds: ID[];
  /** 恢复实测的首条读数时间；与故障结束重叠的替代关系在复核完成前标记待复核 */
  recoveredReadingAt?: ISOTime;
  reviewNote?: string;
}

/** 支流汇入条件：仅在闸控/活跃区间计入，区间按 [activeFrom, activeTo) 生效 */
export interface TributaryCondition {
  id: ID;
  /** 汇入点位于参考站→目标断面之间 */
  targetSectionId: ID;
  name: string;
  /** 活跃区间起点（含） */
  activeFrom: ISOTime;
  /** 活跃区间终点（不含）；undefined 表示长期活跃 */
  activeTo?: ISOTime;
  /** 工程估算的支流贡献范围（与目标断面同 unit） */
  contributionRange: [number, number];
  /** 无支流测站时为 true，贡献只能给界不能给点估计 */
  ungaged: boolean;
  note?: string;
}

/**
 * 水文关系（经工程批准）：参考断面 → 目标断面的传播时差与允许衰减/增幅界。
 * 不依赖长历史，规则可解释；复杂回水条件下 backwaterWiden 显式加宽区间。
 */
export interface HydrologicRelation {
  id: ID;
  targetSectionId: ID;
  referenceSectionId: ID;
  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  /** 传播时间窗口（秒）：目标断面 t 时刻的量对应参考站 [t-τmax, t-τmin] */
  travelTimeMinSeconds: number;
  travelTimeMaxSeconds: number;
  /** 允许衰减/增幅系数界（乘法）：target ≈ reference × k，k ∈ [kMin, kMax] */
  attenuationMin: number;
  attenuationMax: number;
  /** 回水附加界（与目标断面同 unit 的加法余量），复杂回水条件下 > 0 */
  backwaterWiden: number;
  /** 校准时段附加比例（如 0.1 表示未校准再放宽 10%） */
  calibrationRelax: number;
  note?: string;
}

/** 条件关系适用环境（相近雨势、闸门状态、季节） */
export interface RelationEnvironment {
  /** 面雨量强度区间 mm/h */
  rainIntensityRange: [number, number];
  /** 闸门状态标签（如 open/closed/regulated），空数组表示不限制 */
  gateStates: string[];
  /** 适用月份区间 1~12 */
  monthRange: [number, number];
}

/** 条件关系拟合样本：历史同步完好时段的配对观测 */
export interface RelationSample {
  at: ISOTime;
  referenceValue: number;
  targetValue: number;
  rainIntensity: number;
  gateState: string;
}

/**
 * 条件关系模型：从历史“双站同步完好”时段拟合 target = slope×ref + intercept，
 * 残差给出预测带；日常情况下比工程界更紧凑，罕见洪水/结构变化时靠环境包络保护。
 */
export interface ConditionalRelation {
  id: ID;
  targetSectionId: ID;
  referenceSectionId: ID;
  fittedFrom: ISOTime;
  fittedTo: ISOTime;
  slope: number;
  intercept: number;
  /** 残差预测带半宽（同 unit，按残差分位数估计） */
  residualBand: number;
  /** 训练样本环境包络：参考值/雨强/闸门状态/月份，超出即判外推不可用 */
  envelope: {
    referenceRange: [number, number];
    rainRange: [number, number];
    gateStates: string[];
    monthRange: [number, number];
  };
  sampleCount: number;
  r2: number;
  environment: RelationEnvironment;
  note?: string;
}

/** 风险分段的四类结论 */
export type RiskClass =
  | 'safe' // 已确认安全：推导上界仍低于承压线
  | 'exceeded' // 已确认超限：推导下界仍高于承压线
  | 'possible' // 可能超限：区间跨越承压线
  | 'undetermined'; // 不可判定：无可用参考/模型或外推失配

/** 区间来源 */
export type RangeSource =
  | 'measured' // 实测（本断面健康时段）
  | 'engineering_propagation' // 工程批准传播时差 + 增减界区间传播
  | 'conditional_fit' // 历史完好时段条件关系预测区间
  | 'none'; // 无可用来源

/** 单条参考证据（同一参考站支撑多目标时不构成独立证据，由引擎标记） */
export interface RiskEvidence {
  referenceSectionId: ID;
  source: RangeSource;
  relationId?: ID;
  /** 参与传播的参考读数 ID */
  sourceReadingIds: ID[];
  /** 该参考站同时支撑的目标断面数（>1 即非独立证据） */
  sharedTargetCount: number;
  independent: boolean;
  /** 传播采用的时差窗口（秒） */
  travelTimeSeconds: [number, number];
  note?: string;
}

/** 断面风险时间段（一个网格区间一条；恢复实测后另起新版本，不回写旧版本） */
export interface SectionRiskSegment {
  id: ID;
  runId: ID;
  sectionId: ID;
  t1: ISOTime;
  t2: ISOTime;
  classification: RiskClass;
  /** 推导量的可能范围 [下界, 上界]（同断面 unit）；不可判定为 null */
  inferredRange: [number, number] | null;
  /** 本断面实测值（健康时段）；故障时段为 null */
  measuredValue: number | null;
  bearingLimit: number;
  warningLimit: number;
  /** 范围来源；多参考站合并时取主导来源并在 evidence 中留痕 */
  source: RangeSource;
  /** 推导标记：true 表示非实测，页面必须明示 */
  inferred: boolean;
  evidence: RiskEvidence[];
  /** 活跃支流贡献的合成范围（同 unit） */
  tributaryRange: [number, number] | null;
  /** 故障结束与替代关系重叠、待人工复核 */
  pendingReview: boolean;
  reviewReasons: string[];
  /** 环境包络外推/失配等限制说明 */
  limitations: string[];
  /** 风险版本号：同一断面每次恢复实测后递增 */
  version: number;
  /** 健康记录 ID（故障时段关联） */
  healthRecordId?: ID;
  note?: string;
}

