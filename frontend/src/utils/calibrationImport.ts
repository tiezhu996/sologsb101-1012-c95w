/**
 * 标定离线包的可恢复入库流程。
 *
 * 三阶段：
 *  1. stageCalibrationPackage：读台账做业务键核对，结果只写入 importBatches / importItems，
 *     原台账与既有数据完全不动（未完成批次可随时丢弃或重试）。
 *  2. commitImportBatch：每条入库项在独立事务内提交，成功即回写检查点；
 *     中断/失败后再调用本函数从检查点续跑，已成功项天然幂等不重复。
 *  3. rebuildDerivedState：全部有效标定落库后，按仪器最新标定重建仪器状态与系统更换提醒；
 *     人工登记的更换单（kind=manual）一律保留不动。
 *
 * 核对键：台站码 + 序列号 + 标定日期（见 calibrationDedup）。
 */
import { db, createId } from '@/utils/db';
import type { BackupPayload } from '@/utils/db';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import { judgeCalibration } from '@/types/calibration';
import type { Instrument, InstrumentState } from '@/types/instrument';
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';
import type { SeisStation } from '@/types/station';
import type { Replace } from '@/types/replace';
import type {
  CalibrationSource,
  ImportBatch,
  ImportItem,
  ImportPreview,
} from '@/types/import';
import {
  calibrationDedupKey,
  normalizeCalibrationDate,
  normalizeSerialNo,
  normalizeStationCode,
  sameCalibrationValues,
  stableHash,
} from '@/utils/calibrationDedup';

/* ------------------------------ 稳定主键 ------------------------------ */

/** 由业务键派生标定主键，保证重试 / 重复导入只覆盖同一行而不产生重复 */
export function importedCalibrationId(dedupKey: string): string {
  return `calimp::${stableHash(dedupKey)}`;
}

/** 仪器的派生系统更换提醒主键（每台仪器至多一条） */
export function reminderId(instrumentId: string): string {
  return `rplrem::${instrumentId}`;
}

function importedArrayId(name: string): string {
  return `arrimp::${stableHash(name.trim())}`;
}

function importedStationId(arrayKey: string, code: string): string {
  return `stnimp::${stableHash(`${arrayKey}|${normalizeStationCode(code)}`)}`;
}

function importedInstrumentId(serialNo: string): string {
  return `insimp::${stableHash(normalizeSerialNo(serialNo))}`;
}

/* ------------------------------ 来源快照 ------------------------------ */

function toSource(
  cal: Pick<Calibration, 'sensitivity' | 'selfNoise' | 'responseVerdict' | 'date' | 'operator' | 'agency' | 'remark'>,
  source: string
): CalibrationSource {
  return {
    sensitivity: cal.sensitivity,
    selfNoise: cal.selfNoise,
    responseVerdict: cal.responseVerdict,
    date: cal.date,
    operator: cal.operator,
    agency: cal.agency,
    remark: cal.remark,
    source,
  };
}

/* ------------------------------ 阶段 1：暂存核对 ------------------------------ */

export interface StageOptions {
  fileName: string;
  payload: BackupPayload;
}

/**
 * 暂存离线包：按「台站码 + 序列号 + 标定日期」核对。
 * - 相同记录（业务键相同、数值一致）只留台账那一条，记为重复一致；
 * - 业务键相同但灵敏度 / 自噪不同：保留两边来源，记为冲突，不写台账待确认；
 * - 台账查不到仪器的标定记为无法核对；
 * - 包内缺失的台阵 / 台站 / 仪器作为参照补登项一并暂存。
 */
export async function stageCalibrationPackage(options: StageOptions): Promise<ImportBatch> {
  const now = Date.now();
  const batchId = createId('impb');

  const [stations, instruments, calibrations] = await Promise.all([
    db.stations.toArray(),
    db.instruments.toArray(),
    db.calibrations.toArray(),
  ]);

  const stationByCode = new Map<string, SeisStation>();
  stations.forEach((station) => {
    stationByCode.set(normalizeStationCode(station.code), station);
  });
  // 序列号按注释为全局唯一，直接以序列号取仪器
  const instrumentBySerial = new Map<string, Instrument>();
  instruments.forEach((instrument) => {
    instrumentBySerial.set(normalizeSerialNo(instrument.serialNo), instrument);
  });
  // 台账标定按业务键归组（同一键理论上只应有一条，归组可兼容历史脏数据）
  const localByKey = new Map<string, Calibration[]>();
  calibrations.forEach((cal) => {
    const list = localByKey.get(cal.dedupKey) ?? [];
    list.push(cal);
    localByKey.set(cal.dedupKey, list);
  });

  const payload = options.payload;
  const payloadStationById = new Map(payload.stations.map((row) => [row.id, row]));
  const payloadArrayById = new Map(payload.arrays.map((row) => [row.id, row]));
  const payloadInstrumentById = new Map(payload.instruments.map((row) => [row.id, row]));

  // 台账已有台阵名（同名即视为已登记，不覆盖）
  const existingArrayNames = new Set((await db.arrays.toArray()).map((row) => row.name.trim()));

  // 包内参照数据按业务键去重登记
  const refArrays = new Map<string, ImportItem>();
  const refStations = new Map<string, ImportItem>();
  const refInstruments = new Map<string, ImportItem>();

  const preview: ImportPreview = {
    totalCalibrations: payload.calibrations.length,
    newCount: 0,
    duplicateEqualCount: 0,
    conflictCount: 0,
    inPackageConflictCount: 0,
    unmatchedCount: 0,
    newArrays: 0,
    newStations: 0,
    newInstruments: 0,
  };

  /** 确保包内某条标定涉及的台阵 / 台站 / 仪器已登记为参照补登项 */
  const ensureReference = (payloadInstrumentId: string): void => {
    const payloadInstrument = payloadInstrumentById.get(payloadInstrumentId);
    if (!payloadInstrument) return;
    const serialKey = normalizeSerialNo(payloadInstrument.serialNo);
    if (!instrumentBySerial.has(serialKey) && !refInstruments.has(serialKey)) {
      refInstruments.set(serialKey, makeReferenceItem(batchId, {
        kind: 'instrument',
        dedupKey: `instrument:${serialKey}`,
        stationCode: payloadStationById.get(payloadInstrument.stationId)?.code ?? '',
        serialNo: payloadInstrument.serialNo,
        date: '',
        rawReference: payloadInstrument as unknown as Record<string, unknown>,
        now,
      }));
    }

    const payloadStation = payloadStationById.get(payloadInstrument.stationId);
    if (!payloadStation) return;
    const stationKey = `${normalizeStationCode(payloadStation.code)}@${payloadStation.arrayId}`;
    const stationCodeKey = normalizeStationCode(payloadStation.code);
    if (!stationByCode.has(stationCodeKey) && !refStations.has(stationKey)) {
      refStations.set(stationKey, makeReferenceItem(batchId, {
        kind: 'station',
        dedupKey: `station:${stationCodeKey}`,
        stationCode: payloadStation.code,
        serialNo: '',
        date: '',
        rawReference: payloadStation as unknown as Record<string, unknown>,
        now,
      }));
    }

    const payloadArray = payloadArrayById.get(payloadStation.arrayId);
    if (!payloadArray) return;
    const arrayKey = payloadArray.name.trim();
    if (!refArrays.has(arrayKey) && !existingArrayNames.has(arrayKey)) {
      refArrays.set(arrayKey, makeReferenceItem(batchId, {
        kind: 'array',
        dedupKey: `array:${arrayKey}`,
        stationCode: '',
        serialNo: '',
        date: '',
        rawReference: payloadArray as unknown as Record<string, unknown>,
        now,
      }));
    }
  };

  // 包内标定按业务键归组
  const incomingGroups = new Map<string, Array<{ cal: Calibration; stationCode: string; serialNo: string }>>();
  for (const raw of payload.calibrations) {
    // 仪器 / 台站优先取离线包行；包内未重复携带参照数据时回退到本地台账解析
    const payloadInstrument = payloadInstrumentById.get(raw.instrumentId);
    const localInstrument = instruments.find((row) => row.id === raw.instrumentId);
    const instrumentRow = payloadInstrument ?? localInstrument ?? null;
    const payloadStation = payloadInstrument
      ? payloadStationById.get(payloadInstrument.stationId)
      : undefined;
    const localStation = instrumentRow
      ? stations.find((row) => row.id === instrumentRow.stationId)
      : undefined;
    const stationRow = payloadStation ?? localStation;
    const stationCode = stationRow?.code ?? '';
    const serialNo = instrumentRow?.serialNo ?? '';
    const dedupKey = calibrationDedupKey(stationCode, serialNo, raw.date);
    const enriched: Calibration = {
      ...raw,
      dedupKey,
      responseVerdict:
        raw.responseVerdict ??
        judgeCalibration(instrumentRow?.type ?? '宽频带', raw.sensitivity, raw.selfNoise),
    };
    const list = incomingGroups.get(dedupKey) ?? [];
    list.push({ cal: enriched, stationCode, serialNo });
    incomingGroups.set(dedupKey, list);
  }

  const calibrationItems: ImportItem[] = [];

  for (const [dedupKey, groupRows] of incomingGroups) {
    const group = groupRows.map((entry) => entry.cal);
    const first = group[0];
    const { stationCode, serialNo } = groupRows[0];
    const payloadInstrument = payloadInstrumentById.get(first.instrumentId) ?? null;
    const payloadStation = payloadInstrument
      ? payloadStationById.get(payloadInstrument.stationId)
      : undefined;

    // 包内同键多份：数值全部一致视为正常重复（按首条入库），否则包内冲突待确认
    const allEqualInPackage = group
      .slice(1)
      .every((row) => sameCalibrationValues(row, first));
    if (!allEqualInPackage) {
      preview.inPackageConflictCount += 1;
      calibrationItems.push(makeCalibrationItem(batchId, {
        dedupKey,
        stationCode,
        serialNo,
        date: first.date,
        classify: 'conflict_in_package',
        state: 'conflict_pending',
        incoming: toSource(first, options.fileName),
        incomingAlternatives: group
          .slice(1)
          .map((row, index) => toSource(row, `${options.fileName}#${index + 2}`)),
        local: null,
        rawCalibration: first,
        now,
      }));
      continue;
    }

    const localRows = localByKey.get(dedupKey) ?? [];
    const local = localRows[0];

    // 包内与本地台账都解析不出仪器 / 台站，才无法核对
    const resolvedInstrument =
      payloadInstrument ?? instruments.find((row) => row.id === first.instrumentId) ?? null;
    const resolvedStation =
      payloadStation ??
      (resolvedInstrument ? stations.find((row) => row.id === resolvedInstrument.stationId) : undefined);

    if (!resolvedInstrument || !resolvedStation) {
      preview.unmatchedCount += 1;
      calibrationItems.push(makeCalibrationItem(batchId, {
        dedupKey,
        stationCode,
        serialNo,
        date: first.date,
        classify: 'unmatched',
        state: 'skipped',
        incoming: toSource(first, options.fileName),
        incomingAlternatives: [],
        local: local ? toSource(local, '本地台账') : null,
        rawCalibration: first,
        error: '离线包与本地台账均缺少该标定对应的仪器或台站信息，无法核对',
        now,
      }));
      continue;
    }

    // 仪器在台账中不存在：登记参照补登，标定按新增处理
    if (!instrumentBySerial.has(normalizeSerialNo(serialNo))) {
      await ensureReference(first.instrumentId);
    }

    if (local) {
      if (sameCalibrationValues(local, first)) {
        preview.duplicateEqualCount += 1;
        calibrationItems.push(makeCalibrationItem(batchId, {
          dedupKey,
          stationCode,
          serialNo,
          date: first.date,
          classify: 'duplicate_equal',
          state: 'skipped',
          incoming: toSource(first, options.fileName),
          incomingAlternatives: [],
          local: toSource(local, '本地台账'),
          rawCalibration: first,
          now,
        }));
      } else {
        preview.conflictCount += 1;
        calibrationItems.push(makeCalibrationItem(batchId, {
          dedupKey,
          stationCode,
          serialNo,
          date: first.date,
          classify: 'conflict',
          state: 'conflict_pending',
          incoming: toSource(first, options.fileName),
          incomingAlternatives: [],
          local: toSource(local, '本地台账'),
          rawCalibration: first,
          now,
        }));
      }
    } else {
      preview.newCount += 1;
      calibrationItems.push(makeCalibrationItem(batchId, {
        dedupKey,
        stationCode,
        serialNo,
        date: first.date,
        classify: 'new',
        state: 'pending',
        incoming: toSource(first, options.fileName),
        incomingAlternatives: [],
        local: null,
        rawCalibration: first,
        now,
      }));
    }
  }

  preview.newArrays = refArrays.size;
  preview.newStations = refStations.size;
  preview.newInstruments = refInstruments.size;

  const referenceItems = [...refArrays.values(), ...refStations.values(), ...refInstruments.values()];
  const items = [...referenceItems, ...calibrationItems];

  const batch: ImportBatch = {
    id: batchId,
    fileName: options.fileName,
    state: 'staged',
    preview,
    payload,
    error: null,
    rebuilt: false,
    createdAt: now,
    updatedAt: now,
    committedAt: null,
  };

  await db.transaction('rw', [db.importBatches, db.importItems], async () => {
    await db.importBatches.add(batch);
    if (items.length > 0) await db.importItems.bulkAdd(items);
  });

  return batch;
}

function makeReferenceItem(
  batchId: string,
  fields: {
    kind: ImportItem['kind'];
    dedupKey: string;
    stationCode: string;
    serialNo: string;
    date: string;
    rawReference: Record<string, unknown>;
    now: number;
  }
): ImportItem {
  return {
    id: createId('impi'),
    batchId,
    kind: fields.kind,
    dedupKey: fields.dedupKey,
    stationCode: fields.stationCode,
    serialNo: fields.serialNo,
    date: fields.date,
    classify: null,
    state: 'pending',
    incoming: null,
    incomingAlternatives: [],
    local: null,
    resolution: null,
    error: null,
    rawCalibration: null,
    rawReference: fields.rawReference,
    createdAt: fields.now,
    updatedAt: fields.now,
  };
}

function makeCalibrationItem(
  batchId: string,
  fields: {
    dedupKey: string;
    stationCode: string;
    serialNo: string;
    date: string;
    classify: ImportItem['classify'];
    state: ImportItem['state'];
    incoming: CalibrationSource;
    incomingAlternatives: CalibrationSource[];
    local: CalibrationSource | null;
    rawCalibration: Calibration;
    error?: string | null;
    now: number;
  }
): ImportItem {
  return {
    id: createId('impi'),
    batchId,
    kind: 'calibration',
    dedupKey: fields.dedupKey,
    stationCode: fields.stationCode,
    serialNo: fields.serialNo,
    date: fields.date,
    classify: fields.classify,
    state: fields.state,
    incoming: fields.incoming,
    incomingAlternatives: fields.incomingAlternatives,
    local: fields.local,
    resolution: null,
    error: fields.error ?? null,
    rawCalibration: fields.rawCalibration,
    rawReference: null,
    createdAt: fields.now,
    updatedAt: fields.now,
  };
}

/* ------------------------------ 阶段 2：逐项入库 + 检查点 ------------------------------ */

export interface CommitProgress {
  batch: ImportBatch;
  /** 本轮处理条数 */
  processed: number;
  /** 仍待处理（非终态）条数 */
  remaining: number;
  /** 是否已做派生状态重建 */
  rebuilt: boolean;
}

const TERMINAL_ITEM_STATES: ReadonlySet<ImportItem['state']> = new Set([
  'committed',
  'skipped',
  'keep_local',
]);

/**
 * 从检查点继续入库。可在 staged / committing / failed / conflicts 状态下重复调用：
 * - 每条记录独立事务提交，成功后立即写回 state（检查点）；
 * - 已成功（committed / skipped / keep_local）的项直接跳过，绝不重复；
 * - 单条失败只记录该项错误并继续其余项；全部有效标定落库后统一重建派生状态。
 */
export async function commitImportBatch(batchId: string): Promise<CommitProgress> {
  const batch = await db.importBatches.get(batchId);
  if (!batch) throw new Error('入库批次不存在或已被清理');
  if (batch.state === 'completed') {
    return { batch, processed: 0, remaining: 0, rebuilt: batch.rebuilt };
  }

  await db.importBatches.update(batchId, { state: 'committing', error: null, updatedAt: Date.now() } as never);

  const items = await db.importItems.where('batchId').equals(batchId).toArray();

  // 参照数据先于标定提交（台阵 → 台站 → 仪器）
  const order: ImportItem['kind'][] = ['array', 'station', 'instrument', 'calibration'];
  const sorted = [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  let processed = 0;
  const touchedInstrumentIds = new Set<string>();

  for (const item of sorted) {
    if (TERMINAL_ITEM_STATES.has(item.state)) {
      // 已成功项不重复；记录其影响的仪器以便（必要时）重建
      const instrumentId = await instrumentIdOfItem(item, batch);
      if (instrumentId) touchedInstrumentIds.add(instrumentId);
      continue;
    }
    if (item.state === 'conflict_pending') {
      // 待人工确认不入库，但其仪器仍纳入本次重建范围
      const instrumentId = await instrumentIdOfItem(item, batch);
      if (instrumentId) touchedInstrumentIds.add(instrumentId);
      continue;
    }
    if (item.state === 'failed') {
      // 失败项重试前清空旧错误
      await db.importItems.update(item.id, { error: null, updatedAt: Date.now() } as never);
    }

    try {
      if (item.kind === 'calibration') {
        const result = await commitCalibrationItem(item, batch);
        if (result?.instrumentId) touchedInstrumentIds.add(result.instrumentId);
      } else {
        await commitReferenceItem(item, batch);
      }
      processed += 1;
    } catch (error) {
      await db.importItems.update(item.id, {
        state: 'failed',
        error: error instanceof Error ? error.message : '入库失败',
        updatedAt: Date.now(),
      } as never);
    }
  }

  return finishBatch(batchId, touchedInstrumentIds, processed);
}

/** 参照补登项入库：已存在（业务键冲突）则跳过，绝不覆盖原台账 */
async function commitReferenceItem(item: ImportItem, batch: ImportBatch): Promise<void> {
  const row = item.rawReference;
  if (!row) throw new Error('参照数据缺失');

  if (item.kind === 'array') {
    const name = String(row.name ?? '').trim();
    const existing = await db.arrays.where('name').equals(name).first();
    if (existing) {
      await markItemSkipped(item, '台账已存在同名台阵，保留原台账');
      return;
    }
    const id = importedArrayId(name);
    const now = Date.now();
    await db.transaction('rw', [db.arrays, db.importItems], async () => {
      await db.arrays.put({ ...(row as object), id, createdAt: now, updatedAt: now } as never);
      await db.importItems.update(item.id, { state: 'committed', updatedAt: now } as never);
    });
    return;
  }

  if (item.kind === 'station') {
    const code = normalizeStationCode(String(row.code ?? ''));
    const existingStation = await db.stations.where('code').equalsIgnoreCase(code).first();
    if (existingStation) {
      await markItemSkipped(item, '台账已存在同台站码台站，保留原台账');
      return;
    }
    const payloadArray = batch.payload.arrays.find(
      (array) => array.id === (row as { arrayId?: string }).arrayId
    );
    const arrayId = payloadArray
      ? (await db.arrays.where('name').equals(payloadArray.name).first())?.id ??
        importedArrayId(payloadArray.name)
      : ((row as { arrayId?: string }).arrayId ?? '');
    const id = importedStationId(String(payloadArray?.name ?? arrayId), code);
    const now = Date.now();
    await db.transaction('rw', [db.stations, db.importItems], async () => {
      await db.stations.put(
        { ...(row as object), id, arrayId, code: code || String(row.code ?? ''), createdAt: now, updatedAt: now } as never
      );
      await db.importItems.update(item.id, { state: 'committed', updatedAt: now } as never);
    });
    return;
  }

  // instrument
  const serialNo = normalizeSerialNo(String(row.serialNo ?? ''));
  const existingInstrument = await db.instruments.where('serialNo').equals(serialNo).first();
  if (existingInstrument) {
    await markItemSkipped(item, '台账已存在同序列号仪器，保留原台账');
    return;
  }
  const payloadStation = batch.payload.stations.find(
    (station) => station.id === (row as { stationId?: string }).stationId
  );
  const stationId = payloadStation
    ? (await db.stations.where('code').equalsIgnoreCase(normalizeStationCode(payloadStation.code)).first())?.id ??
      importedStationId(
        batch.payload.arrays.find((array) => array.id === payloadStation.arrayId)?.name ?? payloadStation.arrayId,
        payloadStation.code
      )
    : ((row as { stationId?: string }).stationId ?? '');
  const id = importedInstrumentId(serialNo);
  const now = Date.now();
  await db.transaction('rw', [db.instruments, db.importItems], async () => {
    await db.instruments.put(
      { ...(row as object), id, stationId, state: '待标定', createdAt: now, updatedAt: now } as never
    );
    await db.importItems.update(item.id, { state: 'committed', updatedAt: now } as never);
  });
}

async function markItemSkipped(item: ImportItem, reason: string): Promise<void> {
  await db.importItems.update(item.id, {
    state: 'skipped',
    error: reason,
    updatedAt: Date.now(),
  } as never);
}

/** 标定项入库：new 写入 / duplicate_equal 跳过 / 冲突按人工选择处理 */
async function commitCalibrationItem(
  item: ImportItem,
  batch: ImportBatch
): Promise<{ instrumentId: string } | null> {
  if (item.classify === 'unmatched') {
    await markItemSkipped(item, item.error ?? '无法核对，未写入台账');
    return null;
  }

  const instrumentId = await resolveInstrumentId(item, batch);
  if (!instrumentId) {
    throw new Error('按序列号找不到对应仪器（参照仪器未补登成功）');
  }

  // 提交前再次按业务键核对台账，保证跨批次 / 手动新增后仍不重复
  const local = await db.calibrations.where('dedupKey').equals(item.dedupKey).first();

  if (item.classify === 'duplicate_equal') {
    if (local) await markItemSkipped(item, '台账已存在一致记录，只留一条');
    else {
      // 台账原记录被删过：数值来源仍可信，直接补写
      await putCalibration(item, instrumentId, item.rawCalibration as Calibration, 'committed');
    }
    return { instrumentId };
  }

  if (item.classify === 'conflict' || item.classify === 'conflict_in_package') {
    if (!item.resolution) {
      await db.importItems.update(item.id, { state: 'conflict_pending', updatedAt: Date.now() } as never);
      return { instrumentId };
    }
    if (item.resolution === 'local') {
      await db.importItems.update(item.id, {
        state: local ? 'keep_local' : 'skipped',
        error: local ? null : '本地记录已不存在，未做改动',
        updatedAt: Date.now(),
      } as never);
      return { instrumentId };
    }
    // resolution: incoming 或包内冲突的来源序号 'incoming:N'
    const chosen = pickResolvedCalibration(item, batch);
    if (!chosen) throw new Error('冲突所选来源数据缺失');
    await putCalibration(item, instrumentId, chosen, 'committed');
    return { instrumentId };
  }

  // new
  if (local) {
    // 别的批次 / 手动操作已写入同业务键：数值一致则跳过，不同则转为冲突待确认
    const candidate = item.rawCalibration as Calibration;
    if (sameCalibrationValues(local, candidate)) {
      await markItemSkipped(item, '同业务键记录已由其他流程入库，数值一致，跳过');
    } else {
      const now = Date.now();
      await db.importItems.update(item.id, {
        classify: 'conflict',
        state: 'conflict_pending',
        local: toSource(local, '本地台账'),
        error: '入库前复检发现台账已有不同数值记录，转为待确认',
        updatedAt: now,
      } as never);
    }
    return { instrumentId };
  }

  await putCalibration(item, instrumentId, item.rawCalibration as Calibration, 'committed');
  return { instrumentId };
}

/** 按人工选择取出对应来源的标定行（包内冲突时重写数值字段） */
function pickResolvedCalibration(item: ImportItem, _batch: ImportBatch): Calibration | null {
  const base = item.rawCalibration;
  if (!base) return null;
  if (item.resolution === 'incoming' || item.resolution === null) return base;
  if (item.resolution === 'local') return null;
  const match = /^incoming:(\d+)$/.exec(item.resolution);
  if (!match) return base;
  const index = Number(match[1]);
  const source = item.incomingAlternatives[index - 1];
  if (!source) return base;
  return {
    ...base,
    sensitivity: source.sensitivity,
    selfNoise: source.selfNoise,
    responseVerdict: source.responseVerdict as ResponseVerdict,
    operator: source.operator,
    agency: source.agency,
    remark: source.remark,
  };
}

async function putCalibration(
  item: ImportItem,
  instrumentId: string,
  source: Calibration,
  state: ImportItem['state']
): Promise<void> {
  const instrument = await db.instruments.get(instrumentId);
  const verdict = judgeCalibration(
    instrument?.type ?? '宽频带',
    source.sensitivity,
    source.selfNoise
  );
  const now = Date.now();
  const row: Calibration = {
    ...source,
    id: importedCalibrationId(item.dedupKey),
    instrumentId,
    date: normalizeCalibrationDate(item.date || source.date),
    responseVerdict: verdict,
    dedupKey: item.dedupKey,
    createdAt: source.createdAt || now,
    updatedAt: now,
  };
  await db.transaction('rw', [db.calibrations, db.importItems], async () => {
    // 业务键相同的旧行先移除，保证「相同记录只留一条」（冲突后采用离线包来源）
    const duplicates = await db.calibrations.where('dedupKey').equals(item.dedupKey).primaryKeys();
    const staleIds = duplicates.filter((id) => id !== row.id);
    if (staleIds.length > 0) await db.calibrations.bulkDelete(staleIds);
    await db.calibrations.put(row);
    await db.importItems.update(item.id, { state, error: null, updatedAt: now } as never);
  });
}

/** 提交时解析仪器：优先台账同序列号，其次本批次补登仪器 */
async function resolveInstrumentId(item: ImportItem, batch: ImportBatch): Promise<string | null> {
  const serial = normalizeSerialNo(item.serialNo);
  if (!serial) return null;
  const existing = await db.instruments.where('serialNo').equals(serial).first();
  if (existing) return existing.id;
  // 包内仪器行（可能尚未补登，重建阶段会先补登）
  const payloadInstrument = batch.payload.instruments.find(
    (row) => normalizeSerialNo(row.serialNo) === serial
  );
  return payloadInstrument ? importedInstrumentId(payloadInstrument.serialNo) : null;
}

async function instrumentIdOfItem(item: ImportItem, batch: ImportBatch): Promise<string | null> {
  if (item.kind !== 'calibration') return null;
  return resolveInstrumentId(item, batch);
}

/* ------------------------------ 阶段 3：重建仪器状态与更换提醒 ------------------------------ */

/**
 * 批次收尾：汇总各项检查点状态，决定批次终态；
 * 无失败且无待确认冲突时，从最终有效的标定记录重建涉及仪器的状态与系统更换提醒。
 * 重建在单个事务内完成，失败则整个批次保持 failed，原台账不变，可整体重试。
 */
async function finishBatch(
  batchId: string,
  touchedInstrumentIds: Set<string>,
  processed: number
): Promise<CommitProgress> {
  const latestItems = await db.importItems.where('batchId').equals(batchId).toArray();
  const failedItems = latestItems.filter((item) => item.state === 'failed');
  const pendingConflictItems = latestItems.filter((item) => item.state === 'conflict_pending');
  const remaining = latestItems.filter(
    (item) => item.state === 'pending' || item.state === 'failed'
  ).length;

  const now = Date.now();

  if (failedItems.length > 0) {
    await db.importBatches.update(batchId, {
      state: 'failed',
      error: `${failedItems.length} 条入库失败：${failedItems[0].error ?? '未知错误'}`,
      updatedAt: now,
    } as never);
    return {
      batch: (await db.importBatches.get(batchId)) as ImportBatch,
      processed,
      remaining,
      rebuilt: false,
    };
  }

  let rebuilt = false;
  // 全部有效标定落库后（允许存在待确认冲突，冲突项不进台账）才重建
  if (remaining === 0) {
    const instrumentIds = [...touchedInstrumentIds];
    await rebuildDerivedState(instrumentIds);
    rebuilt = true;
  }

  const nextState: ImportBatch['state'] =
    pendingConflictItems.length > 0 ? 'conflicts' : remaining === 0 ? 'completed' : 'committing';

  await db.importBatches.update(batchId, {
    state: nextState,
    rebuilt,
    committedAt: nextState === 'completed' ? now : null,
    error:
      pendingConflictItems.length > 0
        ? `${pendingConflictItems.length} 条数值冲突待人工确认（双方来源已保留）`
        : null,
    updatedAt: now,
  } as never);

  const batch = (await db.importBatches.get(batchId)) as ImportBatch;
  return { batch, processed, remaining, rebuilt };
}

/**
 * 从最终有效的标定记录重建派生状态：
 * - 仪器状态：已停用的人工处置保持不变；其余按最近一次标定结论——不合格→待标定，合格/待判定→在用。
 * - 系统更换提醒：最近标定不合格，或超过标定周期（365 天）未标定，且没有未闭环人工更换单时，
 *   生成一条 kind=reminder 的待更换提醒；恢复正常则删除该仪器的提醒。
 * 人工更换单（manual）与其他仪器不受影响。
 */
export async function rebuildDerivedState(instrumentIds: string[]): Promise<void> {
  if (instrumentIds.length === 0) return;
  const now = Date.now();

  await db.transaction(
    'rw',
    [db.instruments, db.calibrations, db.replaces, db.importItems],
    async () => {
      for (const instrumentId of instrumentIds) {
        const instrument = await db.instruments.get(instrumentId);
        if (!instrument) continue;

        const own = await db.calibrations
          .where('instrumentId')
          .equals(instrumentId)
          .toArray();
        own.sort((a, b) => b.date.localeCompare(a.date));
        const latest = own[0];

        // —— 仪器状态（已停用属于人工处置，不覆盖）——
        if (instrument.state !== '已停用') {
          const nextState: InstrumentState =
            latest && latest.responseVerdict === '不合格' ? '待标定' : '在用';
          if (instrument.state !== nextState) {
            await db.instruments.update(instrumentId, { state: nextState, updatedAt: now } as never);
          }
        }

        // —— 系统更换提醒 ——
        const openManual = await db.replaces
          .where('instrumentId')
          .equals(instrumentId)
          .filter((row) => row.state !== '已复核' && (row.kind ?? 'manual') === 'manual')
          .first();

        const latestDate = latest?.date ?? instrument.installDate;
        const latestTime = Date.parse(`${latestDate}T00:00:00`);
        const overdue =
          Number.isFinite(latestTime) && now - latestTime > CALIBRATION_CYCLE_DAYS * 86400000;
        const unqualified = latest?.responseVerdict === '不合格';
        const needReminder = (overdue || unqualified) && !openManual && instrument.state !== '已停用';

        const existingReminderId = reminderId(instrumentId);
        const existingReminder = await db.replaces.get(existingReminderId);

        if (needReminder) {
          const reason = unqualified
            ? `最近标定（${latest?.date ?? '—'}）结论不合格，按入库重建提醒安排更换 / 复标`
            : `已超标定周期 ${CALIBRATION_CYCLE_DAYS} 天未标定（最近 ${latestDate}），按入库重建提醒安排标定或更换`;
          const row: Replace = {
            id: existingReminderId,
            instrumentId,
            reason,
            newSerialNo: '',
            date: new Date(now).toISOString().slice(0, 10),
            state: '待更换',
            kind: 'reminder',
            operator: '系统提醒',
            remark: '由标定入库流程依据最终有效标定自动重建',
            createdAt: existingReminder?.createdAt ?? now,
            updatedAt: now,
          };
          await db.replaces.put(row);
        } else if (existingReminder) {
          await db.replaces.delete(existingReminderId);
        }
      }
    }
  );
}

/* ------------------------------ 冲突人工确认 ------------------------------ */

export interface ConflictResolution {
  /** 'incoming' 采用离线包；'local' 保留台账；'incoming:N' 包内第 N（从 1 起）个来源 */
  resolution: string;
}

/**
 * 对一条数值冲突入库项给出人工结论：
 * 记录选择并将项置回 pending，随后续跑同一批次——写入标定、重建该仪器状态与提醒。
 * 未确认前台账保持原样；已成功的其他项不会重复处理。
 */
export async function resolveImportConflict(
  batchId: string,
  itemId: string,
  choice: string
): Promise<CommitProgress> {
  const item = await db.importItems.get(itemId);
  if (!item || item.batchId !== batchId) throw new Error('冲突记录不存在');
  if (item.state !== 'conflict_pending') throw new Error('该记录已处理，无需重复确认');

  const now = Date.now();
  await db.importItems.update(itemId, {
    resolution: choice,
    state: 'pending',
    error: null,
    updatedAt: now,
  } as never);
  await db.importBatches.update(batchId, { state: 'committing', updatedAt: now } as never);

  return commitImportBatch(batchId);
}

/* ------------------------------ 查询 ------------------------------ */

export async function listImportBatches(): Promise<ImportBatch[]> {
  const rows = await db.importBatches.orderBy('createdAt').reverse().toArray();
  return rows;
}

export async function listImportItems(batchId: string): Promise<ImportItem[]> {
  return db.importItems.where('batchId').equals(batchId).toArray();
}

/** 批次处理进度（供页面进度条与重试判断） */
export function summarizeItems(items: ImportItem[]): {
  total: number;
  committed: number;
  skipped: number;
  keepLocal: number;
  failed: number;
  conflictPending: number;
  pending: number;
} {
  const summary = {
    total: items.length,
    committed: 0,
    skipped: 0,
    keepLocal: 0,
    failed: 0,
    conflictPending: 0,
    pending: 0,
  };
  items.forEach((item) => {
    switch (item.state) {
      case 'committed':
        summary.committed += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
      case 'keep_local':
        summary.keepLocal += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'conflict_pending':
        summary.conflictPending += 1;
        break;
      default:
        summary.pending += 1;
    }
  });
  return summary;
}
