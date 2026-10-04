/**
 * 离线包合并入库流水线的单元测试（fake-indexeddb 承载 Dexie）。
 * 覆盖：核对去重、冲突双边保留与确认、状态/提醒重建、断点续传与幂等。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllTables, db, type BackupPayload } from '@/utils/db';
import {
  deterministicCalibrationId,
  discardImportBatch,
  resolveImportConflict,
  runImportBatch,
  startImportBatch,
} from '@/utils/importPipeline';
import { dedupeKeyOf } from '@/types/importBatch';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument, InstrumentState } from '@/types/instrument';
import type { Replace } from '@/types/replace';
import type { SeisStation } from '@/types/station';

const NOW = Date.now();
const daysAgo = (days: number): string => new Date(NOW - days * 86400000).toISOString().slice(0, 10);

function makeStation(id: string, code: string): SeisStation {
  return {
    id,
    arrayId: 'arr_t',
    code,
    lat: 30,
    lng: 103,
    elevM: 1000,
    bedrock: '花岗岩',
    siteNote: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeInstrument(
  id: string,
  stationId: string,
  serialNo: string,
  state: InstrumentState = '在用',
  installDate = daysAgo(600)
): Instrument {
  return {
    id,
    stationId,
    type: '宽频带',
    model: 'CMG-3ESPC',
    serialNo,
    installDate,
    state,
    remark: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeCalibration(
  id: string,
  instrumentId: string,
  date: string,
  sensitivity: number,
  selfNoise: number,
  responseVerdict: ResponseVerdict = '合格'
): Calibration {
  return {
    id,
    instrumentId,
    date,
    sensitivity,
    selfNoise,
    responseVerdict,
    operator: '陈立群',
    agency: '省地震局计量站',
    remark: '',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 组装离线包：台站 / 仪器 / 标定记录使用包内独立 id，模拟另一套台账的导出 */
function makePayload(parts: {
  stations?: SeisStation[];
  instruments?: Instrument[];
  calibrations?: Calibration[];
}): BackupPayload {
  return {
    app: 'gbseisarray',
    dbVersion: 3,
    exportedAt: new Date(NOW).toISOString(),
    arrays: [],
    stations: parts.stations ?? [],
    instruments: parts.instruments ?? [],
    calibrations: parts.calibrations ?? [],
    replaces: [],
  };
}

async function runPayload(payload: BackupPayload, source = '标定一组') {
  const fileText = JSON.stringify(payload);
  const batch = await startImportBatch(payload, { fileName: 'offline.json', source, fileText });
  return runImportBatch(batch.id);
}

beforeEach(async () => {
  await clearAllTables();
});

describe('核对：相同记录只留一条', () => {
  it('与台账完全一致的记录被跳过，不重复入库', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));
    await db.calibrations.put(makeCalibration('cal_1', 'ins_1', '2024-05-01', 1500, 2));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', '2024-05-01', 1500, 2)],
    });
    const batch = await runPayload(payload);

    expect(batch.status).toBe('已完成');
    expect(await db.calibrations.count()).toBe(1);
    const items = await db.importItems.where('batchId').equals(batch.id).toArray();
    expect(items[0].resolution).toBe('重复跳过');
    expect(items[0].status).toBe('已跳过');
  });

  it('批次内部重复（两组都录了同一条）也只留一条', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [
        makeCalibration('p_cal_1', 'p_ins_1', '2024-05-01', 1500, 2),
        makeCalibration('p_cal_2', 'p_ins_1', '2024-05-01', 1500, 2),
      ],
    });
    const batch = await runPayload(payload);

    expect(batch.status).toBe('已完成');
    expect(await db.calibrations.count()).toBe(1);
    const items = await db.importItems.where('batchId').equals(batch.id).toArray();
    expect(items.map((item) => item.resolution).sort()).toEqual(['新增', '重复跳过']);
  });

  it('新记录正常入库，且同一批次重复执行不产生重复', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', '2024-06-01', 1500, 2)],
    });
    const fileText = JSON.stringify(payload);
    const batch = await startImportBatch(payload, { fileName: 'a.json', source: '一组', fileText });
    const done = await runImportBatch(batch.id);
    expect(done.status).toBe('已完成');
    expect(await db.calibrations.count()).toBe(1);

    // 同一批次重复执行：已完成直接返回
    await runImportBatch(batch.id);
    expect(await db.calibrations.count()).toBe(1);

    // 同一文件再次导入：新建批次但全部核对为重复
    const again = await startImportBatch(payload, { fileName: 'a.json', source: '一组', fileText });
    expect(again.id).not.toBe(batch.id);
    const againDone = await runImportBatch(again.id);
    expect(againDone.status).toBe('已完成');
    expect(againDone.skippedCount).toBe(1);
    expect(await db.calibrations.count()).toBe(1);
  });
});

describe('核对：数值不同保留两边待确认', () => {
  it('冲突时台账不动、现场值挂起，批次置为待确认', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));
    await db.calibrations.put(makeCalibration('cal_1', 'ins_1', '2024-05-01', 1500, 2));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', '2024-05-01', 1600, 2.5)],
    });
    const batch = await runPayload(payload);

    expect(batch.status).toBe('待确认');
    expect(await db.calibrations.count()).toBe(1);
    const ledger = await db.calibrations.get('cal_1');
    expect(ledger?.sensitivity).toBe(1500);

    const items = await db.importItems.where('batchId').equals(batch.id).toArray();
    expect(items[0].status).toBe('待确认');
    expect(items[0].conflictWith?.calibrationId).toBe('cal_1');
    expect(items[0].conflictWith?.sensitivity).toBe(1500);
    expect(items[0].conflictWith?.source).toBe('台账');
  });

  it('确认「采用现场值」后回写台账原记录并闭环批次', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));
    await db.calibrations.put(makeCalibration('cal_1', 'ins_1', '2024-05-01', 1500, 2));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', '2024-05-01', 1600, 2.5)],
    });
    const batch = await runPayload(payload);
    const item = (await db.importItems.where('batchId').equals(batch.id).toArray())[0];

    const done = await resolveImportConflict(item.id, '采用现场值');
    expect(done.status).toBe('已完成');
    expect(await db.calibrations.count()).toBe(1);
    const ledger = await db.calibrations.get('cal_1');
    expect(ledger?.sensitivity).toBe(1600);
    expect(ledger?.selfNoise).toBe(2.5);
  });

  it('确认「保留台账值」后台账不动、现场项跳过', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));
    await db.calibrations.put(makeCalibration('cal_1', 'ins_1', '2024-05-01', 1500, 2));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', '2024-05-01', 1600, 2.5)],
    });
    const batch = await runPayload(payload);
    const item = (await db.importItems.where('batchId').equals(batch.id).toArray())[0];

    const done = await resolveImportConflict(item.id, '保留台账值');
    expect(done.status).toBe('已完成');
    const ledger = await db.calibrations.get('cal_1');
    expect(ledger?.sensitivity).toBe(1500);
    const after = await db.importItems.get(item.id);
    expect(after?.status).toBe('已跳过');
    expect(after?.resolution).toBe('保留台账值');
  });
});

describe('重建：仪器状态与更换提醒来自最终有效标定记录', () => {
  it('最新标定不合格 → 仪器置为待标定并生成更换提醒，且不重复提醒', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', daysAgo(10), 1500, 5.0, '不合格')],
    });
    const batch = await runPayload(payload);
    expect(batch.status).toBe('已完成');

    const instrument = await db.instruments.get('ins_1');
    expect(instrument?.state).toBe('待标定');

    const reminders = await db.replaces.toArray();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].state).toBe('待更换');
    expect(reminders[0].reason).toContain('不合格');

    // 同一文件再次导入：记录核对为重复，提醒不重复生成
    await runPayload(payload);
    expect(await db.replaces.count()).toBe(1);
  });

  it('超期未标定 → 置为待标定并生成超期提醒', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1', '在用', daysAgo(500)));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', daysAgo(400), 1500, 2)],
    });
    await runPayload(payload);

    const instrument = await db.instruments.get('ins_1');
    expect(instrument?.state).toBe('待标定');
    const reminders = await db.replaces.toArray();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].reason).toContain('超期');
  });

  it('已有未闭环更换提醒的仪器不重复建提醒', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));
    const existing: Replace = {
      id: 'rpl_manual',
      instrumentId: 'ins_1',
      reason: '人工登记的更换',
      newSerialNo: '',
      date: daysAgo(1),
      state: '待更换',
      operator: '周渝',
      remark: '',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await db.replaces.put(existing);

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', daysAgo(10), 1500, 5.0, '不合格')],
    });
    await runPayload(payload);

    expect(await db.replaces.count()).toBe(1);
    expect((await db.replaces.toArray())[0].id).toBe('rpl_manual');
  });

  it('已停用仪器不改状态、不建提醒，但标定记录仍入库', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1', '已停用'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', daysAgo(10), 1500, 5.0, '不合格')],
    });
    await runPayload(payload);

    const instrument = await db.instruments.get('ins_1');
    expect(instrument?.state).toBe('已停用');
    expect(await db.replaces.count()).toBe(0);
    expect(await db.calibrations.count()).toBe(1);
  });

  it('合格且在周期内 → 仪器恢复在用', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1', '待标定'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', daysAgo(10), 1500, 2)],
    });
    await runPayload(payload);

    const instrument = await db.instruments.get('ins_1');
    expect(instrument?.state).toBe('在用');
    expect(await db.replaces.count()).toBe(0);
  });
});

describe('断点续传：中途失败从检查点重试', () => {
  it('写入第 3 项时中断，重跑后续传完成且不重复', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));

    const calibrations = [1, 2, 3, 4, 5].map((n) =>
      makeCalibration(`p_cal_${n}`, 'p_ins_1', `2024-0${n}-15`, 1500 + n, 2)
    );
    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations,
    });
    const batch = await startImportBatch(payload, {
      fileName: 'a.json',
      source: '一组',
      fileText: JSON.stringify(payload),
    });

    // 模拟在第 3 个入库项写入前崩溃
    const crashed = await runImportBatch(batch.id, {
      beforeApplyItem: (item) => {
        if (item.seq === 2) throw new Error('模拟断电');
      },
    });
    expect(crashed.status).toBe('已失败');
    expect(crashed.error).toContain('模拟断电');
    expect(crashed.cursor).toBe(2);
    expect(await db.calibrations.count()).toBe(2);

    // 从检查点重试：已写入的 2 条不重复，剩余 3 条补齐
    const resumed = await runImportBatch(batch.id);
    expect(resumed.status).toBe('已完成');
    expect(resumed.insertedCount).toBe(5);
    expect(await db.calibrations.count()).toBe(5);

    // 再跑一遍已完成批次：什么都不变
    await runImportBatch(batch.id);
    expect(await db.calibrations.count()).toBe(5);
  });

  it('同一离线包在失败后被重复选择时续传原批次', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_1', '2024-06-01', 1500, 2)],
    });
    const fileText = JSON.stringify(payload);
    const first = await startImportBatch(payload, { fileName: 'a.json', source: '一组', fileText });
    await runImportBatch(first.id, {
      beforeApplyItem: () => {
        throw new Error('模拟中断');
      },
    });

    const second = await startImportBatch(payload, { fileName: 'a.json', source: '一组', fileText });
    expect(second.id).toBe(first.id);

    const done = await runImportBatch(second.id);
    expect(done.status).toBe('已完成');
    expect(await db.calibrations.count()).toBe(1);
  });

  it('未完成批次与冲突双边的暂存行都保留，清除批次不影响已入库台账', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));
    await db.calibrations.put(makeCalibration('cal_1', 'ins_1', '2024-05-01', 1500, 2));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_1', 'p_stn_1', 'SN-1')],
      calibrations: [
        makeCalibration('p_cal_1', 'p_ins_1', '2024-05-01', 1600, 2.5),
        makeCalibration('p_cal_2', 'p_ins_1', '2024-06-01', 1500, 2),
      ],
    });
    const batch = await runPayload(payload);
    expect(batch.status).toBe('待确认');
    // 新增项已入库、冲突项双边保留
    expect(await db.calibrations.count()).toBe(2);
    expect(await db.importItems.where('batchId').equals(batch.id).count()).toBe(2);

    await discardImportBatch(batch.id);
    expect(await db.importBatches.count()).toBe(0);
    expect(await db.importItems.count()).toBe(0);
    // 台账不受清除影响
    expect(await db.calibrations.count()).toBe(2);
  });
});

describe('台账中不存在的仪器与台站', () => {
  it('未知序列号：按离线包档案自动登记仪器并入库标定', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01')],
      instruments: [makeInstrument('p_ins_9', 'p_stn_1', 'SN-NEW', '在用', '2023-01-01')],
      calibrations: [makeCalibration('p_cal_1', 'p_ins_9', daysAgo(10), 1500, 2)],
    });
    const batch = await runPayload(payload);
    expect(batch.status).toBe('已完成');

    const instruments = await db.instruments.toArray();
    expect(instruments).toHaveLength(1);
    expect(instruments[0].serialNo).toBe('SN-NEW');
    expect(instruments[0].stationId).toBe('stn_1');
    expect(await db.calibrations.count()).toBe(1);
    const cal = (await db.calibrations.toArray())[0];
    expect(cal.instrumentId).toBe(instruments[0].id);
    expect(cal.id).toBe(deterministicCalibrationId(dedupeKeyOf('ST01', 'SN-NEW', cal.date)));
  });

  it('未知台站码：该入库项标记失败并说明原因，不阻断其他项', async () => {
    await db.stations.put(makeStation('stn_1', 'ST01'));
    await db.instruments.put(makeInstrument('ins_1', 'stn_1', 'SN-1'));

    const payload = makePayload({
      stations: [makeStation('p_stn_1', 'ST01'), makeStation('p_stn_99', 'ST99')],
      instruments: [
        makeInstrument('p_ins_1', 'p_stn_1', 'SN-1'),
        makeInstrument('p_ins_99', 'p_stn_99', 'SN-99'),
      ],
      calibrations: [
        makeCalibration('p_cal_1', 'p_ins_1', '2024-06-01', 1500, 2),
        makeCalibration('p_cal_99', 'p_ins_99', '2024-06-02', 1500, 2),
      ],
    });
    const batch = await runPayload(payload);

    expect(batch.status).toBe('已完成');
    expect(batch.failedCount).toBe(1);
    expect(await db.calibrations.count()).toBe(1);
    const failed = (await db.importItems.where('batchId').equals(batch.id).toArray()).find(
      (item) => item.status === '失败'
    );
    expect(failed?.error).toContain('ST99');
  });
});
