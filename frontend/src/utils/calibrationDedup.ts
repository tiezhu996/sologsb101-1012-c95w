/**
 * 标定业务键与数值核对的纯函数：
 * 离线包合并时以「台站码 + 序列号 + 标定日期」作为同一次标定的唯一核对键。
 */

/** 台站码归一化：去空白并转大写（LTX01 与 ltx01 视为同站） */
export function normalizeStationCode(code: string): string {
  return (code ?? '').trim().toUpperCase();
}

/** 序列号归一化：仅去首尾空白（序列号大小写敏感，保留原样） */
export function normalizeSerialNo(serialNo: string): string {
  return (serialNo ?? '').trim();
}

/** 标定日期归一化：截取 YYYY-MM-DD，去除空白 */
export function normalizeCalibrationDate(date: string): string {
  return (date ?? '').trim().slice(0, 10);
}

/** 拼接核对键：台站码|序列号|标定日期 */
export function calibrationDedupKey(stationCode: string, serialNo: string, date: string): string {
  return [
    normalizeStationCode(stationCode),
    normalizeSerialNo(serialNo),
    normalizeCalibrationDate(date),
  ].join('|');
}

/**
 * 数值一致性核对：只比较标定数值（灵敏度、自噪）。
 * 标定人 / 机构 / 备注差异不视为冲突；响应结论由数值重新判定，不参与比较。
 */
export function sameCalibrationValues(
  a: { sensitivity: number; selfNoise: number },
  b: { sensitivity: number; selfNoise: number }
): boolean {
  return Math.abs(Number(a.sensitivity) - Number(b.sensitivity)) < 1e-9 &&
    Math.abs(Number(a.selfNoise) - Number(b.selfNoise)) < 1e-9;
}

/** FNV-1a 32 位哈希 → base36，用于由业务键派生稳定主键（重试 / 重复导入不产生新行） */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
