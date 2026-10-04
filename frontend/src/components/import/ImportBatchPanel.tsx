/**
 * 离线包合并入库面板：可恢复的入库流程入口与批次管理。
 * - 选择离线包 JSON 后按「台站码 + 序列号 + 标定日期」核对去重；
 * - 数值冲突双边保留，逐条人工确认；
 * - 批次分阶段落检查点，中断后可「继续」从检查点重试，已成功项不重复。
 * 被 /geometry 页消费。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Input,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { UploadFile } from 'antd';
import EmptyPanel from '@/components/common/EmptyPanel';
import { db } from '@/utils/db';
import { readFileText, validateBackup } from '@/utils/export';
import {
  discardImportBatch,
  resolveImportConflict,
  runImportBatch,
  startImportBatch,
} from '@/utils/importPipeline';
import { isBatchResumable, type ImportBatch, type ImportItem } from '@/types/importBatch';
import { useIdbTable } from '@/hooks/useIdbTable';

/** 批次状态徽标颜色 */
const STATUS_COLOR: Record<ImportBatch['status'], string> = {
  待入库: 'default',
  入库中: 'processing',
  待确认: 'warning',
  已完成: 'success',
  已失败: 'error',
};

/** 数值三元组文案：灵敏度 / 自噪 / 结论 */
function valuesText(row: {
  sensitivity: number;
  selfNoise: number;
  responseVerdict: string;
  operator: string;
  agency: string;
}): string {
  return `灵敏度 ${row.sensitivity} · 自噪 ${row.selfNoise} · ${row.responseVerdict}`;
}

export default function ImportBatchPanel() {
  const { message } = AntdApp.useApp();
  const { rows: batches } = useIdbTable<ImportBatch>(() => db.importBatches);
  const { rows: items } = useIdbTable<ImportItem>(() => db.importItems, { sortByUpdatedAt: false });

  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  const itemsByBatch = useMemo(() => {
    const map = new Map<string, ImportItem[]>();
    items.forEach((item) => {
      const list = map.get(item.batchId) ?? [];
      list.push(item);
      map.set(item.batchId, list);
    });
    return map;
  }, [items]);

  const conflicts = useMemo(
    () =>
      items
        .filter((item) => item.status === '待确认')
        .sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey) || a.seq - b.seq),
    [items]
  );

  const failedItems = useMemo(() => items.filter((item) => item.status === '失败'), [items]);

  /** 按入库项实况统计（比批次字段更实时） */
  const liveCounts = (batchId: string): { inserted: number; skipped: number; conflict: number; failed: number } => {
    const list = itemsByBatch.get(batchId) ?? [];
    return {
      inserted: list.filter((item) => item.status === '已写入').length,
      skipped: list.filter((item) => item.status === '已跳过').length,
      conflict: list.filter((item) => item.status === '待确认').length,
      failed: list.filter((item) => item.status === '失败').length,
    };
  };

  /** 批次跑完后的统一播报 */
  const report = (batch: ImportBatch): void => {
    if (batch.status === '待确认') {
      message.warning(`发现 ${batch.conflictCount} 条数值冲突，台账值与现场值均已保留，请在下方逐条确认`);
    } else if (batch.status === '已完成') {
      message.success(
        `入库完成：新增 ${batch.insertedCount} 条、跳过重复 ${batch.skippedCount} 条` +
          (batch.failedCount > 0 ? `、失败 ${batch.failedCount} 条` : '') +
          `；已按最终标定记录重建 ${batch.rebuiltInstrumentCount} 台仪器状态、新增 ${batch.createdReminderCount} 条更换提醒`
      );
    } else if (batch.status === '已失败') {
      message.error(`入库中断：${batch.error || '未知错误'}；点击「继续」可从检查点重试，已成功项不会重复`);
    }
  };

  const handleStart = async (): Promise<void> => {
    const file = fileList[0]?.originFileObj ?? (fileList[0] as unknown as File | undefined);
    if (!file) {
      message.warning('请先选择离线包 JSON 文件');
      return;
    }
    setBusy(true);
    try {
      const text = await readFileText(file as File);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        message.error('文件不是合法的 JSON，无法解析');
        return;
      }
      const validation = validateBackup(parsed);
      if (!validation.ok || !validation.payload) {
        message.error(`离线包校验失败：${validation.errors.join('；')}`);
        return;
      }
      const batch = await startImportBatch(validation.payload, {
        fileName: (file as File).name ?? '离线包.json',
        source,
        fileText: text,
      });
      const final = await runImportBatch(batch.id);
      report(final);
      setFileList([]);
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async (batch: ImportBatch): Promise<void> => {
    setBusy(true);
    try {
      const final = await runImportBatch(batch.id);
      report(final);
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async (item: ImportItem, choice: '采用现场值' | '保留台账值'): Promise<void> => {
    setBusy(true);
    try {
      await resolveImportConflict(item.id, choice);
      message.success(
        choice === '采用现场值' ? '已采用现场值回写台账，并重建仪器状态与提醒' : '已保留台账值，现场记录已跳过'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="gb-panel"
      size="small"
      title="离线包合并入库（可恢复）"
      extra={<span className="gb-hint">核对键：台站码 + 序列号 + 标定日期</span>}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="多个标定组的离线包在此合并：相同记录只留一条；数值不同则两边保留待确认；写入前自动从最终有效标定记录重建仪器状态与更换提醒；中断后可从检查点继续，已成功项不重复。"
        />

        <Space wrap>
          <Upload
            fileList={fileList}
            maxCount={1}
            accept="application/json"
            beforeUpload={() => false}
            onChange={({ fileList: list }) => setFileList(list)}
          >
            <Button icon={<UploadOutlined />}>选择离线包 JSON</Button>
          </Upload>
          <Input
            style={{ width: 180 }}
            placeholder="来源标识（如：标定一组）"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            maxLength={20}
          />
          <Button type="primary" icon={<PlayCircleOutlined />} loading={busy} onClick={() => void handleStart()}>
            开始合并入库
          </Button>
        </Space>

        {batches.length === 0 ? (
          <EmptyPanel
            title="还没有入库批次"
            description="选择离线包 JSON 后开始合并入库；批次进度与冲突都会留痕，可随时继续。"
            compact
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={batches}
            pagination={false}
            columns={[
              {
                title: '离线包 / 来源',
                width: 220,
                render: (_: unknown, batch) => (
                  <div>
                    <div className="gb-mono">{batch.fileName}</div>
                    <div className="gb-hint">{batch.source}</div>
                  </div>
                ),
              },
              {
                title: '状态',
                width: 100,
                render: (_: unknown, batch) => <Tag color={STATUS_COLOR[batch.status]}>{batch.status}</Tag>,
              },
              {
                title: '阶段 / 进度',
                width: 190,
                render: (_: unknown, batch) => (
                  <div>
                    <div>
                      <Tag>{batch.stage}</Tag>
                      <span className="gb-mono gb-hint">
                        {batch.cursor}/{batch.totalItems}
                      </span>
                    </div>
                    <Progress
                      percent={batch.totalItems === 0 ? 100 : Math.round((batch.cursor / batch.totalItems) * 100)}
                      size="small"
                      showInfo={false}
                      status={batch.status === '已失败' ? 'exception' : undefined}
                    />
                  </div>
                ),
              },
              {
                title: '新增 / 跳过 / 冲突 / 失败',
                width: 170,
                align: 'right',
                render: (_: unknown, batch) => {
                  const counts = liveCounts(batch.id);
                  return (
                    <span className="gb-mono">
                      {counts.inserted} / {counts.skipped} /{' '}
                      <span className={counts.conflict > 0 ? 'gb-danger' : ''}>{counts.conflict}</span> /{' '}
                      <span className={counts.failed > 0 ? 'gb-danger' : ''}>{counts.failed}</span>
                    </span>
                  );
                },
              },
              {
                title: '状态重建 / 提醒',
                width: 120,
                align: 'right',
                render: (_: unknown, batch) => (
                  <span className="gb-mono">
                    {batch.statePatches.length} / {batch.createdReminderCount}
                  </span>
                ),
              },
              {
                title: '说明',
                ellipsis: true,
                render: (_: unknown, batch) =>
                  batch.error ? (
                    <span className="gb-danger">{batch.error}</span>
                  ) : (
                    <span className="gb-hint">
                      {batch.status === '待确认'
                        ? '存在待确认冲突，请在下方逐条处理'
                        : batch.status === '已完成'
                          ? '批次已闭环'
                          : '未完成批次已保留，可继续'}
                    </span>
                  ),
              },
              {
                title: '操作',
                width: 170,
                render: (_: unknown, batch) => (
                  <Space size={6}>
                    {isBatchResumable(batch) ? (
                      <Button
                        size="small"
                        type="primary"
                        icon={<SyncOutlined />}
                        loading={busy}
                        onClick={() => void handleResume(batch)}
                      >
                        继续
                      </Button>
                    ) : null}
                    <Popconfirm
                      title="清除批次暂存记录"
                      description="仅清除批次与入库项暂存行，不影响已入库台账。确认清除？"
                      okText="清除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void discardImportBatch(batch.id)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} disabled={batch.status === '入库中'}>
                        清除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}

        {conflicts.length > 0 ? (
          <Card
            size="small"
            className="gb-panel"
            title={
              <Space>
                <CloseCircleOutlined style={{ color: '#d68910' }} />
                <span>待确认冲突（{conflicts.length} 条）：台账值与现场值均已保留</span>
              </Space>
            }
          >
            <Table
              rowKey="id"
              size="small"
              className="gb-table-compact"
              dataSource={conflicts}
              pagination={false}
              columns={[
                {
                  title: '核对键',
                  width: 220,
                  render: (_: unknown, item) => (
                    <div>
                      <div className="gb-mono">
                        {item.stationCode} · {item.serialNo}
                      </div>
                      <div className="gb-hint gb-mono">{item.date}</div>
                    </div>
                  ),
                },
                {
                  title: '留存值',
                  width: 260,
                  render: (_: unknown, item) =>
                    item.conflictWith ? (
                      <div>
                        <div className="gb-mono">{valuesText(item.conflictWith)}</div>
                        <div className="gb-hint">
                          来源：{item.conflictWith.source} · {item.conflictWith.operator || '未署名'}
                        </div>
                      </div>
                    ) : (
                      '—'
                    ),
                },
                {
                  title: '现场值',
                  width: 260,
                  render: (_: unknown, item) => (
                    <div>
                      <div className="gb-mono gb-danger">{valuesText(item)}</div>
                      <div className="gb-hint">
                        来源：{item.source} · {item.operator || '未署名'}
                      </div>
                    </div>
                  ),
                },
                {
                  title: '操作',
                  width: 220,
                  render: (_: unknown, item) => (
                    <Space size={6}>
                      <Button
                        size="small"
                        type="primary"
                        icon={<CheckCircleOutlined />}
                        loading={busy}
                        onClick={() => void handleResolve(item, '采用现场值')}
                      >
                        采用现场值
                      </Button>
                      <Button size="small" loading={busy} onClick={() => void handleResolve(item, '保留台账值')}>
                        保留台账值
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        ) : null}

        {failedItems.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={`${failedItems.length} 条记录因数据问题未入库（不影响其他记录）`}
            description={
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {failedItems.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <Typography.Text className="gb-mono">
                      {item.stationCode || '未知台站'} · {item.serialNo || '未知序列号'} · {item.date || '无日期'}
                    </Typography.Text>
                    ：{item.error}
                  </li>
                ))}
                {failedItems.length > 5 ? <li>…共 {failedItems.length} 条</li> : null}
              </ul>
            }
          />
        ) : null}
      </Space>
    </Card>
  );
}
