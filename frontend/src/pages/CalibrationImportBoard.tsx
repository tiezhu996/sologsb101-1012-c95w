/**
 * 模块 5：/imports 标定离线包可恢复入库
 *
 * 两个野外标定组合并离线包时：
 *  - 上传后先「暂存核对」，不改动正式台账，预览新增 / 重复一致 / 数值冲突 / 无法核对；
 *  - 核对键为台站码 + 序列号 + 标定日期，相同记录只留一条，数值不同保留两边来源待确认；
 *  - 入库逐项提交并写检查点，中途失败可从断点重试，已成功项不重复；
 *  - 全部有效标定落库后自动重建仪器状态与系统更换提醒；
 *  - 原台账与未完成批次始终保留，批次记录用于审计与再次重试。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Modal,
  Progress,
  Radio,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  CheckCircleOutlined,
  FileSearchOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { db, watchTable } from '@/utils/db';
import {
  readFileText,
  validateBackup,
} from '@/utils/export';
import {
  commitImportBatch,
  listImportBatches,
  resolveImportConflict,
  stageCalibrationPackage,
  summarizeItems,
} from '@/utils/calibrationImport';
import {
  IMPORT_BATCH_STATE_LABELS,
  IMPORT_ITEM_CLASS_LABELS,
  type ImportBatch,
  type ImportItem,
} from '@/types/import';

const { Dragger } = Upload;
const { Title, Text, Paragraph } = Typography;

const BATCH_TAG_COLOR: Record<ImportBatch['state'], string> = {
  staged: 'default',
  committing: 'processing',
  conflicts: 'warning',
  failed: 'error',
  completed: 'success',
};

const CLASS_TAG_COLOR: Record<string, string> = {
  new: 'green',
  duplicate_equal: 'default',
  conflict: 'red',
  conflict_in_package: 'orange',
  unmatched: 'default',
};

const ITEM_STATE_LABELS: Record<ImportItem['state'], string> = {
  pending: '待入库',
  committed: '已入库',
  skipped: '已跳过',
  failed: '失败',
  keep_local: '保留台账',
  conflict_pending: '待确认',
};

interface ConflictChoice {
  itemId: string;
  choice: string;
}

export default function CalibrationImportBoard() {
  const { message } = AntdApp.useApp();
  const [busy, setBusy] = useState(false);
  const [stagedPreview, setStagedPreview] = useState<ImportBatch | null>(null);
  const [resolving, setResolving] = useState<ImportItem | null>(null);
  const [choice, setChoice] = useState<string>('incoming');
  const [batches, setBatches] = useState<ImportBatch[]>([]);

  useEffect(() => {
    // 批次表实时订阅：入库逐项提交时进度自动刷新；
    // 「入库中」批次（上次会话中途退出）不自动写库，仅保留给操作者点「从检查点重试」。
    const unsubscribe = watchTable<ImportBatch>(() => db.importBatches).subscribe((rows) => {
      setBatches([...rows].sort((a, b) => b.createdAt - a.createdAt));
    });
    return unsubscribe;
  }, []);  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: async (file) => {
      setBusy(true);
      try {
        const text = await readFileText(file);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          message.error('文件不是合法的 JSON，无法解析');
          return false;
        }
        const validation = validateBackup(parsed);
        if (!validation.ok || !validation.payload) {
          message.error(`备份校验失败：${validation.errors.join('；')}`);
          return false;
        }
        const batch = await stageCalibrationPackage({
          fileName: file.name,
          payload: validation.payload,
        });
        setStagedPreview(batch);
        message.success('离线包已暂存核对，正式台账尚未改动');
      } catch (error) {
        message.error(error instanceof Error ? error.message : '暂存失败');
      } finally {
        setBusy(false);
      }
      return false;
    },
  };

  const startCommit = async (batchId: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await commitImportBatch(batchId);
      if (result.batch.state === 'completed') {
        message.success(
          `入库完成：${result.processed} 条本次写入，仪器状态与更换提醒已按最终标定重建`
        );
      } else if (result.batch.state === 'conflicts') {
        message.warning('部分数值冲突待人工确认，双方来源已保留；其余有效记录已入库');
      } else if (result.batch.state === 'failed') {
        message.error(`入库未完成：${result.batch.error ?? '存在失败项，可从检查点重试'}`);
      } else {
        message.info('批次仍有未完成项');
      }
      setStagedPreview((current) => (current?.id === batchId ? result.batch : current));
    } finally {
      setBusy(false);
    }
  };

  const confirmStaged = async (): Promise<void> => {
    if (!stagedPreview) return;
    Modal.confirm({
      title: '确认开始入库？',
      content:
        '入库将逐项写入并记录检查点；原台账在全部有效标定落库前保持不变，中途失败可重试且成功项不重复。',
      okText: '开始入库',
      cancelText: '再看看',
      onOk: () => startCommit(stagedPreview.id),
    });
  };

  const openResolve = (item: ImportItem): void => {
    setResolving(item);
    setChoice('incoming');
  };

  const submitResolution = async (): Promise<void> => {
    if (!resolving) return;
    setBusy(true);
    try {
      const result = await resolveImportConflict(resolving.batchId, resolving.id, choice);
      setResolving(null);
      message.success(
        result.batch.state === 'completed'
          ? '冲突已确认，批次完成，仪器状态与更换提醒已重建'
          : '冲突已确认并入库，仍有其他待处理项'
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '确认失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div>
        <Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
          标定离线包入库
        </Title>
        <p className="gb-hint">
          两个标定组野外各自登记的离线包在此合并：按台站码、序列号与标定日期核对，相同记录只留一条，
          数值不同则保留两边来源待确认；入库从检查点可恢复，原台账与未完成批次保留，成功项不重复。
        </p>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<FileSearchOutlined />}
        message="暂存核对阶段不改动正式台账"
        description="上传仅生成入库批次与核对结果；确认入库后逐项提交，全部有效标定落库后才统一重建仪器状态与系统更换提醒。人工登记的更换单不受影响。"
      />

      <Card className="gb-panel" size="small" title="① 选择离线包 JSON">
        <Dragger {...uploadProps} disabled={busy} style={{ padding: '8px 0' }}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽标定离线包到此处</p>
          <p className="ant-upload-hint">支持备份结构 JSON（含台站 / 仪器 / 标定记录），仅暂存本机</p>
        </Dragger>
      </Card>

      {stagedPreview ? <StagedPreviewCard batch={stagedPreview} busy={busy} onCommit={confirmStaged} /> : null}

      <BatchHistory
        busy={busy}
        batches={batches}
        onRetry={startCommit}
        onResolve={openResolve}
      />

      <ConflictModal
        item={resolving}
        choice={choice}
        busy={busy}
        onChange={setChoice}
        onCancel={() => setResolving(null)}
        onOk={submitResolution}
      />
    </div>
  );
}

/* ------------------------------ 暂存预览 ------------------------------ */

function StagedPreviewCard({
  batch,
  busy,
  onCommit,
}: {
  batch: ImportBatch;
  busy: boolean;
  onCommit: () => void;
}): JSX.Element {
  const preview = batch.preview;
  const hasConflict = preview.conflictCount + preview.inPackageConflictCount > 0;
  return (
    <Card
      className="gb-panel"
      size="small"
      title={
        <Space wrap>
          <span>② 核对预览 · {batch.fileName}</span>
          <Tag>{IMPORT_BATCH_STATE_LABELS[batch.state]}</Tag>
        </Space>
      }
      extra={
        <Space>
          <Text type="secondary" className="gb-hint">
            正式台账尚未改动
          </Text>
          {batch.state === 'staged' || batch.state === 'failed' ? (
            <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} onClick={onCommit}>
              开始入库
            </Button>
          ) : null}
        </Space>
      }
    >
      <Space size={28} wrap style={{ marginBottom: 12 }}>
        <Statistic title="标定记录总数" value={preview.totalCalibrations} />
        <Statistic title="新增" value={preview.newCount} valueStyle={{ color: '#2e7d32' }} />
        <Statistic title="重复一致（跳过）" value={preview.duplicateEqualCount} />
        <Statistic
          title="数值冲突（待确认）"
          value={preview.conflictCount + preview.inPackageConflictCount}
          valueStyle={{ color: '#c0392b' }}
        />
        <Statistic title="无法核对" value={preview.unmatchedCount} valueStyle={{ color: '#8a6d00' }} />
        <Statistic
          title="参照补登（台阵/台站/仪器）"
          value={`${preview.newArrays}/${preview.newStations}/${preview.newInstruments}`}
        />
      </Space>
      {hasConflict ? (
        <Alert
          type="warning"
          showIcon
          message="检测到数值冲突：同一台站码 + 序列号 + 标定日期下两边灵敏度或自噪不同"
          description="冲突记录不会自动入库，批次入库后可在下方批次明细中逐条选择采用哪边来源，确认后才写入并重建设备状态。"
        />
      ) : (
        <Alert type="success" showIcon message="未发现数值冲突，可直接入库" />
      )}
    </Card>
  );
}

/* ------------------------------ 批次历史与明细 ------------------------------ */

function BatchHistory({
  busy,
  batches,
  onRetry,
  onResolve,
}: {
  busy: boolean;
  batches: ImportBatch[];
  onRetry: (batchId: string) => void;
  onResolve: (item: ImportItem) => void;
}): JSX.Element {
  return (
    <Card className="gb-panel" size="small" title={`③ 入库批次（${batches.length}，未完成批次保留可重试）`}>
      {batches.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有入库批次。上传标定离线包后将在此显示核对结果与检查点进度。"
        />
      ) : (
        <Collapse
          accordion
          items={batches.map((batch) => ({
            key: batch.id,
            label: (
              <Space wrap>
                <Tag color={BATCH_TAG_COLOR[batch.state]}>{IMPORT_BATCH_STATE_LABELS[batch.state]}</Tag>
                <b>{batch.fileName}</b>
                <span className="gb-hint">
                  {new Date(batch.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </span>
                {batch.error ? (
                  <Tag icon={<WarningOutlined />} color="error">
                    {batch.error}
                  </Tag>
                ) : null}
              </Space>
            ),
            extra: (
              <Space onClick={(event) => event.stopPropagation()}>
                {batch.state === 'failed' || batch.state === 'staged' || batch.state === 'committing' ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    loading={busy}
                    onClick={() => onRetry(batch.id)}
                  >
                    {batch.state === 'staged' ? '开始入库' : '从检查点重试'}
                  </Button>
                ) : null}
              </Space>
            ),
            children: <BatchDetail batch={batch} busy={busy} onRetry={onRetry} onResolve={onResolve} />,
          }))}
        />
      )}
    </Card>
  );
}

function BatchDetail({
  batch,
  busy,
  onRetry,
  onResolve,
}: {
  batch: ImportBatch;
  busy: boolean;
  onRetry: (batchId: string) => void;
  onResolve: (item: ImportItem) => void;
}): JSX.Element {
  const [items, setItems] = useState<ImportItem[] | null>(null);

  useEffect(() => {
    // 检查点明细订阅：每条记录提交后状态实时刷新（进度条与失败项）
    const unsubscribe = watchTable<ImportItem>(() => db.importItems).subscribe((rows) => {
      setItems(rows.filter((row) => row.batchId === batch.id));
    });
    return unsubscribe;
  }, [batch.id]);

  const summary = useMemo(() => summarizeItems(items ?? []), [items]);
  const done = summary.committed + summary.skipped + summary.keepLocal;
  const percent = summary.total === 0 ? 100 : Math.round((done / summary.total) * 100);

  if (!items) return <div className="gb-hint">读取检查点…</div>;

  const referenceItems = items.filter((item) => item.kind !== 'calibration');
  const calibrationItems = items.filter((item) => item.kind === 'calibration');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Descriptions size="small" column={3} bordered>
        <Descriptions.Item label="批次编号">
          <span className="gb-mono">{batch.id}</span>
        </Descriptions.Item>
        <Descriptions.Item label="重建派生状态">
          {batch.rebuilt ? <Tag color="green">已重建仪器状态 / 更换提醒</Tag> : <Tag>尚未重建</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="完成时间">
          {batch.committedAt ? new Date(batch.committedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
        </Descriptions.Item>
      </Descriptions>

      <div>
        <Progress percent={percent} status={summary.failed > 0 ? 'exception' : summary.conflictPending > 0 ? 'active' : 'normal'} />
        <Space wrap size={16} className="gb-hint">
          <span>已入库 {summary.committed}</span>
          <span>跳过 {summary.skipped}</span>
          <span>保留台账 {summary.keepLocal}</span>
          <span className={summary.failed > 0 ? 'gb-danger' : ''}>失败 {summary.failed}</span>
          <span className={summary.conflictPending > 0 ? 'gb-danger' : ''}>待确认 {summary.conflictPending}</span>
          <span>待处理 {summary.pending}</span>
        </Space>
      </div>

      {batch.state === 'failed' ? (
        <Alert
          type="error"
          showIcon
          message={`入库中途失败：${batch.error ?? ''}`}
          description="已成功项记录在检查点中不会重复写入，点击「从检查点重试」只处理剩余失败项。"
          action={
            <Button size="small" danger loading={busy} onClick={() => onRetry(batch.id)}>
              从检查点重试
            </Button>
          }
        />
      ) : null}

      {referenceItems.length > 0 ? (
        <div>
          <Text strong>参照数据补登（{referenceItems.length}）</Text>
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            pagination={false}
            dataSource={referenceItems}
            columns={[
              {
                title: '类型',
                dataIndex: 'kind',
                width: 90,
                render: (kind: string) =>
                  ({ array: '台阵', station: '台站', instrument: '仪器' })[kind] ?? kind,
              },
              { title: '业务键', dataIndex: 'dedupKey', ellipsis: true, className: 'gb-mono' },
              {
                title: '状态',
                dataIndex: 'state',
                width: 160,
                render: (state: ImportItem['state'], item) => (
                  <ItemStateTag state={state} error={item.error} />
                ),
              },
            ]}
          />
        </div>
      ) : null}

      <Table
        rowKey="id"
        size="small"
        className="gb-table-compact"
        pagination={{ pageSize: 8, showSizeChanger: false }}
        dataSource={calibrationItems}
        columns={[
          {
            title: '台站码',
            dataIndex: 'stationCode',
            width: 100,
            className: 'gb-mono',
            render: (value: string) => value || '—',
          },
          {
            title: '序列号',
            dataIndex: 'serialNo',
            width: 190,
            className: 'gb-mono',
            render: (value: string) => value || '—',
          },
          { title: '标定日期', dataIndex: 'date', width: 110, className: 'gb-mono' },
          {
            title: '核对结论',
            dataIndex: 'classify',
            width: 110,
            render: (classify: ImportItem['classify']) =>
              classify ? (
                <Tag color={CLASS_TAG_COLOR[classify]}>{IMPORT_ITEM_CLASS_LABELS[classify]}</Tag>
              ) : (
                '—'
              ),
          },
          {
            title: '双方数值',
            width: 260,
            render: (_: unknown, item: ImportItem) => (
              <Space direction="vertical" size={0}>
                {item.incoming ? (
                  <span className="gb-mono">
                    包方：{item.incoming.sensitivity} / {item.incoming.selfNoise}
                    {item.incomingAlternatives.length > 0
                      ? ` 等 ${item.incomingAlternatives.length + 1} 份`
                      : ''}
                  </span>
                ) : null}
                {item.local ? (
                  <span className="gb-mono">
                    台账：{item.local.sensitivity} / {item.local.selfNoise}
                  </span>
                ) : null}
              </Space>
            ),
          },
          {
            title: '检查点状态',
            width: 200,
            render: (_: unknown, item: ImportItem) => <ItemStateTag state={item.state} error={item.error} />,
          },
          {
            title: '操作',
            width: 130,
            render: (_: unknown, item: ImportItem) =>
              item.state === 'conflict_pending' ? (
                <Button size="small" danger icon={<WarningOutlined />} onClick={() => onResolve(item)}>
                  确认来源
                </Button>
              ) : item.resolution ? (
                <Tag icon={<CheckCircleOutlined />} color="green">
                  已确认
                </Tag>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </div>
  );
}

function ItemStateTag({ state, error }: { state: ImportItem['state']; error: string | null }): JSX.Element {
  const color =
    state === 'committed'
      ? 'green'
      : state === 'failed'
        ? 'red'
        : state === 'conflict_pending'
          ? 'orange'
          : state === 'pending'
            ? 'blue'
            : 'default';
  return (
    <Space direction="vertical" size={0}>
      <Tag color={color}>{ITEM_STATE_LABELS[state]}</Tag>
      {error ? <span className="gb-hint gb-danger">{error}</span> : null}
    </Space>
  );
}

/* ------------------------------ 冲突确认弹窗 ------------------------------ */

function ConflictModal({
  item,
  choice,
  busy,
  onChange,
  onCancel,
  onOk,
}: {
  item: ImportItem | null;
  choice: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onOk: () => void;
}): JSX.Element {
  const options = useMemo(() => {
    if (!item) return [];
    const list: Array<{ value: string; source: NonNullable<ImportItem['incoming']>; badge: string }> = [];
    if (item.incoming) list.push({ value: 'incoming', source: item.incoming, badge: '离线包' });
    item.incomingAlternatives.forEach((source, index) => {
      list.push({ value: `incoming:${index + 1}`, source, badge: `离线包#${index + 2}` });
    });
    return list;
  }, [item]);

  return (
    <Modal
      open={item !== null}
      title="数值冲突 · 选择保留来源"
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={busy}
      okText="确认并入库"
      cancelText="取消"
      width={620}
    >
      {item ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="台站码">{item.stationCode || '—'}</Descriptions.Item>
            <Descriptions.Item label="序列号">{item.serialNo || '—'}</Descriptions.Item>
            <Descriptions.Item label="标定日期">{item.date}</Descriptions.Item>
          </Descriptions>
          <Paragraph type="secondary" className="gb-hint" style={{ margin: 0 }}>
            同一台站、同一仪器、同一标定日期出现不同数值，请确认以哪边为准；确认后该业务键只保留一条记录，
            并自动重建该仪器状态与更换提醒。
          </Paragraph>
          <Radio.Group value={choice} onChange={(event) => onChange(event.target.value as string)}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {options.map((option) => (
                <Radio key={option.value} value={option.value} style={{ alignItems: 'flex-start' }}>
                  <Space direction="vertical" size={0}>
                    <Space>
                      <Tag color="blue">{option.badge}</Tag>
                      <b className="gb-mono">
                        灵敏度 {option.source.sensitivity} · 自噪 {option.source.selfNoise}
                      </b>
                      <Tag>{option.source.responseVerdict}</Tag>
                    </Space>
                    <span className="gb-hint">
                      {option.source.date} · {option.source.operator || '未署名'} ·{' '}
                      {option.source.agency || '未填写机构'}
                      {option.source.remark ? ` · ${option.source.remark}` : ''}
                    </span>
                  </Space>
                </Radio>
              ))}
              {item.local ? (
                <Radio value="local" style={{ alignItems: 'flex-start' }}>
                  <Space direction="vertical" size={0}>
                    <Space>
                      <Tag>本地台账</Tag>
                      <b className="gb-mono">
                        灵敏度 {item.local.sensitivity} · 自噪 {item.local.selfNoise}
                      </b>
                      <Tag>{item.local.responseVerdict}</Tag>
                    </Space>
                    <span className="gb-hint">
                      {item.local.date} · {item.local.operator || '未署名'} · {item.local.agency || '未填写机构'}
                      {item.local.remark ? ` · ${item.local.remark}` : ''}
                    </span>
                  </Space>
                </Radio>
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 4 }}
                  message="该冲突发生在离线包内部（同一业务键多份记录），无台账侧来源可比"
                />
              )}
            </Space>
          </Radio.Group>
        </div>
      ) : null}
    </Modal>
  );
}
