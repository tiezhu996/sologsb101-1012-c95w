/**
 * 可恢复的标定离线包入库流程类型。
 *
 * 流程阶段：
 *   staged（仅暂存，不碰正式台账）
 *     → committing（逐项入库 + 检查点）
 *     → conflicts（仍有数值冲突待人工确认）/ failed（中途失败，可重试）/ completed（完成）
 *
 * 台账在所有有效标定写入后才做一次性「派生状态重建」（仪器状态 + 系统更换提醒），
 * 因此未完成的批次不会影响原台账；批次与未完成项永久保留用于审计与重试。
 */
import type { BackupPayload } from '@/utils/db';

/** 批次生命周期状态 */
export type ImportBatchState = 'staged' | 'committing' | 'conflicts' | 'failed' | 'completed';

export const IMPORT_BATCH_STATES: ImportBatchState[] = [
  'staged',
  'committing',
  'conflicts',
  'failed',
  'completed',
];

/** 单条入库项核对结论（暂存时决定，不随后续提交改变） */
export type ImportItemClass =
  /** 台账中不存在该业务键，作为新标定写入 */
  | 'new'
  /** 台账已有相同业务键且数值一致，只留一条，跳过 */
  | 'duplicate_equal'
  /** 台账已有相同业务键但数值不同，保留两边来源待确认（不进台账） */
  | 'conflict'
  /** 离线包内部同一业务键出现多次且互相不一致，包内待确认 */
  | 'conflict_in_package'
  /** 找不到台站码 / 序列号对应的仪器，无法核对，不进台账 */
  | 'unmatched';

/** 单条入库项处理状态（检查点） */
export type ImportItemState = 'pending' | 'committed' | 'skipped' | 'failed' | 'keep_local' | 'conflict_pending';

/** 参照数据（台阵 / 台站 / 仪器）入库项类型 */
export type ImportReferenceKind = 'array' | 'station' | 'instrument';

/** 一条标定的双方来源（冲突时各保留一份快照） */
export interface CalibrationSource {
  /** 灵敏度（V·s/m） */
  sensitivity: number;
  /** 自噪 */
  selfNoise: number;
  /** 脉冲响应结论（按数值重新初判，仅供展示） */
  responseVerdict: string;
  /** 标定日期 */
  date: string;
  /** 标定人 */
  operator: string;
  /** 标定机构 */
  agency: string;
  /** 备注 */
  remark: string;
  /** 来源标识（离线包文件名或「本地台账」） */
  source: string;
}

/** 暂存预览统计（写入前给操作者核对，不触碰台账） */
export interface ImportPreview {
  /** 离线包标定原始条数 */
  totalCalibrations: number;
  /** 新增 */
  newCount: number;
  /** 重复且一致（将跳过） */
  duplicateEqualCount: number;
  /** 与台账数值冲突 */
  conflictCount: number;
  /** 包内重复且互相冲突 */
  inPackageConflictCount: number;
  /** 无法核对（缺台站 / 仪器） */
  unmatchedCount: number;
  /** 包内参照数据：待补登台阵 */
  newArrays: number;
  /** 待补登台站 */
  newStations: number;
  /** 待补登仪器 */
  newInstruments: number;
}

/**
 * 入库批次：一个离线包对应一条。
 * payload 为离线包原文（structured-clone 可存），重试时无需重新选择文件。
 */
export interface ImportBatch {
  id: string;
  /** 离线包文件名（来源标识） */
  fileName: string;
  /** 批次当前状态 */
  state: ImportBatchState;
  /** 暂存预览统计 */
  preview: ImportPreview;
  /** 离线包原文（含台阵 / 台站 / 仪器 / 标定 / 更换，仅用于重试与审计） */
  payload: BackupPayload;
  /** 最近一次失败原因（可重试时展示） */
  error: string | null;
  /** 派生状态重建是否已完成（仪器状态 + 系统更换提醒） */
  rebuilt: boolean;
  createdAt: number;
  updatedAt: number;
  committedAt: number | null;
}

/**
 * 入库项：标定核对结果或参照数据补登。
 * 每项在独立小事务内提交，成功后回写 state 作为检查点；重试只捞未成功项。
 */
export interface ImportItem {
  id: string;
  /** 所属批次 */
  batchId: string;
  /** 'calibration' 为标定记录，其余为参照数据补登 */
  kind: ImportReferenceKind | 'calibration';
  /** 业务核对键（台站码|序列号|标定日期）；参照项为各自的业务键 */
  dedupKey: string;
  /** 台站码（展示与核对用） */
  stationCode: string;
  /** 仪器序列号 */
  serialNo: string;
  /** 标定日期 */
  date: string;
  /** 核对结论（仅 kind=calibration） */
  classify: ImportItemClass | null;
  /** 检查点：处理状态 */
  state: ImportItemState;
  /** 离线包带来的来源（new / 冲突时的包方快照） */
  incoming: CalibrationSource | null;
  /** 包内同一业务键存在多份且互相不一致时的其余来源（0 号即 incoming） */
  incomingAlternatives: CalibrationSource[];
  /** 台账已有来源（冲突时的地方快照） */
  local: CalibrationSource | null;
  /** 冲突待确认时人工选中的来源：incoming / local；包内冲突为组内序号 */
  resolution: string | null;
  /** 提交失败原因 */
  error: string | null;
  /** 包内原始标定行（用于提交，结构化克隆可存） */
  rawCalibration: import('@/types/calibration').Calibration | null;
  /** 参照数据原始行（array/station/instrument） */
  rawReference: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export const IMPORT_ITEM_CLASS_LABELS: Record<ImportItemClass, string> = {
  new: '新增标定',
  duplicate_equal: '重复一致',
  conflict: '数值冲突',
  conflict_in_package: '包内冲突',
  unmatched: '无法核对',
};

export const IMPORT_BATCH_STATE_LABELS: Record<ImportBatchState, string> = {
  staged: '待入库',
  committing: '入库中',
  conflicts: '待确认冲突',
  failed: '失败可重试',
  completed: '已完成',
};
