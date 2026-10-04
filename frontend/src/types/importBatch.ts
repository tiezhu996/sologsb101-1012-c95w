/**
 * 离线包合并入库：批次与入库项的类型定义与纯函数。
 * 两个标定组各自登记的离线包合并时，按「台站码 + 序列号 + 标定日期」核对：
 * 相同记录只留一条，数值不同保留两边来源待确认；
 * 入库流水线分阶段落检查点，失败后可从检查点重试，已成功项不重复。
 */
import type { ResponseVerdict } from '@/types/calibration';
import type { InstrumentState, InstrumentType } from '@/types/instrument';

/** 入库流水线阶段（检查点粒度，按序推进） */
export type ImportStage = '解析' | '核对' | '重建' | '写入' | '完成';

export const IMPORT_STAGES: ImportStage[] = ['解析', '核对', '重建', '写入', '完成'];

/** 批次状态：已失败 / 待入库 / 入库中 均可从检查点继续 */
export type ImportBatchStatus = '待入库' | '入库中' | '待确认' | '已完成' | '已失败';

export const IMPORT_BATCH_STATUSES: ImportBatchStatus[] = ['待入库', '入库中', '待确认', '已完成', '已失败'];

/** 核对结论 */
export type ImportResolution =
  | '待核对'
  | '新增'
  | '重复跳过'
  | '冲突待确认'
  | '采用现场值'
  | '保留台账值';

/** 入库项状态 */
export type ImportItemStatus = '待写入' | '已写入' | '已跳过' | '待确认' | '失败';

/** 冲突时另一侧（台账或同批次先到记录）的数值快照，用于双边对比与确认 */
export interface ConflictSnapshot {
  /** 台账侧标定记录 id（同批次冲突时为先到项的确定性 id） */
  calibrationId: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  /** 来源标识：「台账」或标定组名 */
  source: string;
}

/** 新登记仪器所需的档案草稿（台站在核对阶段按台站码解析并回填 stationId） */
export interface InstrumentDraftPlan {
  stationCode: string;
  /** 台账台站 id：解析阶段为空串，核对阶段回填 */
  stationId: string;
  type: InstrumentType;
  model: string;
  installDate: string;
}

/** 入库项：离线包中一条标定记录的暂存行，随批次持久化，断点续传的依据 */
export interface ImportItem {
  id: string;
  batchId: string;
  /** 批次内序号，写入游标按它推进 */
  seq: number;
  /** 核对键：台站码|序列号|标定日期 */
  dedupeKey: string;
  stationCode: string;
  serialNo: string;
  /** 标定日期（YYYY-MM-DD） */
  date: string;
  sensitivity: number;
  selfNoise: number;
  responseVerdict: ResponseVerdict;
  operator: string;
  agency: string;
  remark: string;
  /** 来源标识（标定组 / 文件名） */
  source: string;
  /** 台账仪器 id（新登记仪器为确定性 id，未解析为空串） */
  instrumentId: string;
  /** 仪器处置方式 */
  instrumentPlan: '匹配台账' | '新登记' | '未解析';
  /** 新登记仪器草稿（序列号在台账中不存在时使用） */
  instrumentDraft: InstrumentDraftPlan | null;
  resolution: ImportResolution;
  status: ImportItemStatus;
  /** 冲突时另一侧的数值快照 */
  conflictWith: ConflictSnapshot | null;
  /** 数据级失败原因（如台站码不存在），不阻断其他入库项 */
  error: string;
  createdAt: number;
  updatedAt: number;
}

/** 仪器状态重建补丁：由最终有效标定记录推导，写入前生成 */
export interface InstrumentStatePatch {
  instrumentId: string;
  serialNo: string;
  stationCode: string;
  from: InstrumentState;
  to: InstrumentState;
  reason: string;
}

/** 更换提醒重建计划项：确定性 id，重复执行不产生重复提醒 */
export interface ReminderPlanItem {
  /** 确定性 id：rpl_imp_<hash(instrumentId)> */
  id: string;
  instrumentId: string;
  serialNo: string;
  stationCode: string;
  reason: string;
  date: string;
}

/** 入库批次：一次离线包合并的持久化检查点 */
export interface ImportBatch {
  id: string;
  /** 文件内容指纹：同一离线包重复选择时续传原批次而不是新建 */
  fingerprint: string;
  fileName: string;
  /** 来源标识（标定组） */
  source: string;
  status: ImportBatchStatus;
  /** 当前待执行阶段（已完成的阶段不会重跑） */
  stage: ImportStage;
  /** 写入游标：已处理到的入库项序号 */
  cursor: number;
  totalItems: number;
  insertedCount: number;
  skippedCount: number;
  conflictCount: number;
  failedCount: number;
  /** 重建计划（写入前生成并落库，写入阶段按它回放） */
  statePatches: InstrumentStatePatch[];
  reminders: ReminderPlanItem[];
  rebuiltInstrumentCount: number;
  createdReminderCount: number;
  /** 流水线级失败原因（中断后可续传） */
  error: string;
  createdAt: number;
  updatedAt: number;
}

/** 核对键：台站码 + 序列号 + 标定日期（前后空白不计） */
export function dedupeKeyOf(stationCode: string, serialNo: string, date: string): string {
  return `${stationCode.trim()}|${serialNo.trim()}|${date.trim()}`;
}

/** 判定两条标定是否为「相同记录」：灵敏度、自噪与响应结论一致即视为同一条 */
export function sameCalibrationValues(
  a: { sensitivity: number; selfNoise: number; responseVerdict: ResponseVerdict },
  b: { sensitivity: number; selfNoise: number; responseVerdict: ResponseVerdict }
): boolean {
  return (
    a.sensitivity === b.sensitivity &&
    a.selfNoise === b.selfNoise &&
    a.responseVerdict === b.responseVerdict
  );
}

/** 批次是否可从检查点继续 */
export function isBatchResumable(batch: Pick<ImportBatch, 'status'>): boolean {
  return batch.status === '待入库' || batch.status === '入库中' || batch.status === '已失败';
}

/** 阶段序号，用于「只执行当前及之后阶段」的断点续跑 */
export function stageOrder(stage: ImportStage): number {
  return IMPORT_STAGES.indexOf(stage);
}
