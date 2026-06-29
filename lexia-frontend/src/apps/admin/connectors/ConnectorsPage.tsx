import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Progress,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  PlusOutlined,
  ReloadOutlined,
  DeleteOutlined,
  FolderOutlined,
  FileOutlined,
  DownloadOutlined,
  ThunderboltOutlined,
  ArrowLeftOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useAdminUi } from '../locale/useAdminI18n'
import { resolveAdminApiToken } from '../../../shared/auth/adminSession'
import { useAuthStore } from '../../../shared/store/authStore'
import { BORDER_COLOR, GOLD, DARK_CARD } from '../../../shared/constants'
import {
  createDriveConnector,
  deleteDriveConnector,
  driveConnectorDownloadUrl,
  listDriveConnectorFiles,
  listDriveConnectors,
  parseGoogleDriveFolderId,
  testDriveConnector,
  fetchDriveConnectorFile,
  type DriveConnector,
  type DriveFileItem,
} from '../../../shared/api/driveConnectors'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

function formatSize(bytes?: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

export function ConnectorsPage() {
  const { t, font, titleStyle, formStyle, labelStyle } = useAdminUi()
  const storeToken = useAuthStore((s) => s.token)

  const [connectors, setConnectors] = useState<DriveConnector[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)

  const [browseFolderId, setBrowseFolderId] = useState<string | null>(null)
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>([])
  const [files, setFiles] = useState<DriveFileItem[]>([])
  const [nextPageToken, setNextPageToken] = useState<string | undefined>()
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null)

  const active = connectors.find((c) => c.id === activeId) || null

  const refresh = useCallback(async () => {
    setLoadingList(true)
    setError(null)
    try {
      const rows = await listDriveConnectors()
      setConnectors(rows)
      if (rows.length && !activeId) {
        setActiveId(rows[0].id)
        setBrowseFolderId(rows[0].folder_id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingList(false)
    }
  }, [activeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (active) {
      setBrowseFolderId(active.folder_id)
      setFolderStack([])
      setFiles([])
      setNextPageToken(undefined)
      setTestMsg(null)
    }
  }, [active?.id])

  const loadFiles = async (folderId: string, pageToken?: string, append = false) => {
    if (!activeId) return
    setLoadingFiles(true)
    setError(null)
    try {
      const res = await listDriveConnectorFiles(activeId, { folderId, pageToken })
      setFiles((prev) => (append ? [...prev, ...res.files] : res.files))
      setNextPageToken(res.nextPageToken)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFiles(false)
    }
  }

  useEffect(() => {
    if (activeId && browseFolderId) {
      void loadFiles(browseFolderId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, browseFolderId])

  const handleCreate = async (values: { name: string; folder_input: string }) => {
    const folderId = parseGoogleDriveFolderId(values.folder_input)
    if (!folderId) {
      message.error(t.connectors.invalidFolderUrl)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const row = await createDriveConnector({
        name: values.name.trim(),
        folder_id: folderId,
        auth_type: 'public_link',
      })
      message.success(t.connectors.created)
      setModalOpen(false)
      form.resetFields()
      await refresh()
      setActiveId(row.id)
    } catch (e) {
      message.error(e instanceof Error ? e.message : t.common.error)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      await deleteDriveConnector(id)
      message.success(t.connectors.deleted)
      if (activeId === id) {
        setActiveId(null)
        setBrowseFolderId(null)
      }
      await refresh()
    } catch (e) {
      message.error(e instanceof Error ? e.message : t.common.error)
    }
  }

  const runTest = async () => {
    if (!activeId) return
    setTesting(true)
    setTestMsg(null)
    setError(null)
    try {
      const res = await testDriveConnector(activeId)
      setTestMsg(res.message)
      message[res.ok ? 'success' : 'warning'](res.message)
      await refresh()
    } catch (e) {
      message.error(e instanceof Error ? e.message : t.common.error)
    } finally {
      setTesting(false)
    }
  }

  const openFolder = (file: DriveFileItem) => {
    setFolderStack((prev) => [...prev, { id: browseFolderId!, name: file.name }])
    setBrowseFolderId(file.id)
  }

  const goUp = () => {
    if (folderStack.length === 0 && active) {
      setBrowseFolderId(active.folder_id)
      return
    }
    const next = [...folderStack]
    const parent = next.pop()
    setFolderStack(next)
    if (parent) setBrowseFolderId(parent.id)
    else if (active) setBrowseFolderId(active.folder_id)
  }

  const downloadFile = async (file: DriveFileItem) => {
    if (!activeId) return
    setDownloadingId(file.id)
    setError(null)
    try {
      const url = driveConnectorDownloadUrl(activeId, file.id, file.name)
      const token = resolveAdminApiToken(storeToken)
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `${t.connectors.downloadFailed} (${res.status})`)
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = file.name
      a.click()
      URL.revokeObjectURL(objectUrl)
      setFiles((prev) =>
        prev.map((f) =>
          f.id === file.id ? { ...f, downloaded: true, downloadedAt: new Date().toISOString() } : f,
        ),
      )
    } catch (e) {
      message.error(e instanceof Error ? e.message : t.common.error)
    } finally {
      setDownloadingId(null)
    }
  }

  const downloadAll = async () => {
    if (!activeId || !browseFolderId) return
    const pending = files.filter((f) => !f.isFolder && !f.downloaded)
    if (pending.length === 0) {
      message.info(t.connectors.downloadAllNothing)
      return
    }
    setDownloadingAll(true)
    setBulkProgress({ current: 0, total: pending.length })
    setError(null)
    let completed = 0
    let failed = 0
    try {
      for (const file of pending) {
        try {
          await fetchDriveConnectorFile(activeId, file.id, file.name)
          completed += 1
        } catch {
          failed += 1
        }
        setBulkProgress({ current: completed + failed, total: pending.length })
      }
      if (failed > 0) {
        message.warning(
          t.connectors.downloadAllPartial
            .replace('{ok}', String(completed))
            .replace('{fail}', String(failed)),
        )
      } else {
        message.success(t.connectors.downloadAllDone.replace('{n}', String(completed)))
      }
      await loadFiles(browseFolderId)
    } catch (e) {
      message.error(e instanceof Error ? e.message : t.common.error)
      await loadFiles(browseFolderId)
    } finally {
      setDownloadingAll(false)
      setBulkProgress(null)
    }
  }

  const fileCount = files.filter((f) => !f.isFolder).length
  const downloadedCount = files.filter((f) => !f.isFolder && f.downloaded).length

  const breadcrumbItems = [
    ...(active
      ? [{ title: active.name, onClick: () => setBrowseFolderId(active.folder_id) }]
      : []),
    ...folderStack.map((f) => ({
      title: f.name,
      onClick: () => {
        const idx = folderStack.findIndex((x) => x.id === f.id)
        if (idx >= 0) {
          setFolderStack(folderStack.slice(0, idx + 1))
          setBrowseFolderId(f.id)
        }
      },
    })),
  ]

  return (
    <div style={{ fontFamily: font }}>
      <Typography.Title level={3} style={{ ...titleStyle, marginBottom: 16 }}>
        <ApiOutlined style={{ marginInlineEnd: 8, color: GOLD }} />
        {t.connectors.title}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontFamily: font, marginBottom: 24 }}>
        {t.connectors.subtitle}
      </Typography.Paragraph>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} style={{ marginBottom: 16 }} />
      )}

      <div style={{ display: 'flex', gap: 16, minHeight: 520 }}>
        <Card
          size="small"
          title={t.connectors.listTitle}
          style={{ width: 280, flexShrink: 0, background: DARK_CARD, borderColor: BORDER_COLOR }}
          extra={
            <Space size={4}>
              <Tooltip title={t.connectors.add}>
                <Button type="text" icon={<PlusOutlined />} onClick={() => setModalOpen(true)} />
              </Tooltip>
              <Tooltip title={t.common.refresh ?? t.connectors.refresh}>
                <Button
                  type="text"
                  icon={<ReloadOutlined spin={loadingList} />}
                  onClick={() => void refresh()}
                />
              </Tooltip>
            </Space>
          }
        >
          {loadingList && connectors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : connectors.length === 0 ? (
            <Empty description={t.connectors.empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              size="small"
              dataSource={connectors}
              renderItem={(item) => (
                <List.Item
                  style={{
                    cursor: 'pointer',
                    background: item.id === activeId ? 'var(--color-gold-tint)' : undefined,
                    borderRadius: 6,
                    padding: '8px 12px',
                  }}
                  onClick={() => setActiveId(item.id)}
                  actions={[
                    <Popconfirm
                      key="del"
                      title={t.connectors.deleteConfirm}
                      onConfirm={(e) => {
                        e?.stopPropagation()
                        void handleDelete(item.id)
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={<span style={{ fontFamily: font, fontSize: 13 }}>{item.name}</span>}
                    description={
                      <Space size={4} wrap>
                        {item.last_test_status === 'success' && (
                          <Tag color="success">{t.connectors.testOk}</Tag>
                        )}
                        {item.last_test_status === 'failed' && (
                          <Tag color="error">{t.connectors.testFailed}</Tag>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {item.folder_id.slice(0, 12)}…
                        </Typography.Text>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>

        <Card
          size="small"
          style={{ flex: 1, background: DARK_CARD, borderColor: BORDER_COLOR }}
          title={
            active ? (
              <Space>
                <span style={{ fontFamily: font }}>{active.name}</span>
                {active.last_test_at && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t.connectors.lastTest}: {dayjs(active.last_test_at).format('DD/MM/YYYY HH:mm')}
                  </Typography.Text>
                )}
              </Space>
            ) : (
              t.connectors.selectConnector
            )
          }
          extra={
            active && (
              <Space>
                {fileCount > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t.connectors.downloadedCount
                      .replace('{done}', String(downloadedCount))
                      .replace('{total}', String(fileCount))}
                  </Typography.Text>
                )}
                <Button
                  icon={<CloudDownloadOutlined />}
                  loading={downloadingAll}
                  disabled={!files.some((f) => !f.isFolder && !f.downloaded)}
                  onClick={() => void downloadAll()}
                  style={{ borderColor: GOLD, color: GOLD }}
                >
                  {t.connectors.downloadAll}
                </Button>
                <Button
                  icon={<ThunderboltOutlined />}
                  loading={testing}
                  onClick={() => void runTest()}
                  style={{ borderColor: GOLD, color: GOLD }}
                >
                  {t.connectors.testConnection}
                </Button>
              </Space>
            )
          }
        >
          {!active ? (
            <Empty description={t.connectors.selectConnector} />
          ) : (
            <>
              {testMsg && (
                <Alert type="info" message={testMsg} style={{ marginBottom: 12 }} closable onClose={() => setTestMsg(null)} />
              )}
              {active.last_test_message && !testMsg && (
                <Alert
                  type={active.last_test_status === 'success' ? 'success' : 'warning'}
                  message={active.last_test_message}
                  style={{ marginBottom: 12 }}
                  showIcon
                />
              )}

              <Space style={{ marginBottom: 12 }}>
                {(folderStack.length > 0 || browseFolderId !== active.folder_id) && (
                  <Button icon={<ArrowLeftOutlined />} size="small" onClick={goUp}>
                    {t.connectors.goUp}
                  </Button>
                )}
                <Breadcrumb items={breadcrumbItems.map((b) => ({ title: b.title }))} />
              </Space>

              {loadingFiles && files.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 48 }}>
                  <Spin tip={t.connectors.loadingFiles} />
                </div>
              ) : files.length === 0 ? (
                <Empty description={t.connectors.noFiles} />
              ) : (
                <>
                  <List
                    size="small"
                    dataSource={files}
                    renderItem={(file) => (
                      <List.Item
                        style={{ cursor: file.isFolder ? 'pointer' : undefined }}
                        onClick={() => file.isFolder && openFolder(file)}
                        actions={
                          file.isFolder
                            ? undefined
                            : [
                                <Button
                                  key="dl"
                                  type="link"
                                  size="small"
                                  icon={<DownloadOutlined />}
                                  loading={downloadingId === file.id}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void downloadFile(file)
                                  }}
                                >
                                  {t.connectors.download}
                                </Button>,
                              ]
                        }
                      >
                        <List.Item.Meta
                          avatar={
                            file.isFolder ? (
                              <FolderOutlined style={{ color: GOLD, fontSize: 18 }} />
                            ) : (
                              <FileOutlined style={{ fontSize: 18 }} />
                            )
                          }
                          title={
                            <Space size={8}>
                              {file.name}
                              {file.downloaded && (
                                <Tag icon={<CheckCircleOutlined />} color="success">
                                  {t.connectors.downloaded}
                                </Tag>
                              )}
                            </Space>
                          }
                          description={
                            <Space size={12} wrap>
                              {!file.isFolder && (
                                <Typography.Text type="secondary">{formatSize(file.size)}</Typography.Text>
                              )}
                              {file.modifiedTime && (
                                <Typography.Text type="secondary">
                                  {dayjs(file.modifiedTime).format('DD/MM/YYYY')}
                                </Typography.Text>
                              )}
                              {file.downloadedAt && (
                                <Typography.Text type="secondary">
                                  {t.connectors.downloadedAt}:{' '}
                                  {dayjs(file.downloadedAt).format('DD/MM/YYYY HH:mm')}
                                </Typography.Text>
                              )}
                            </Space>
                          }
                        />
                      </List.Item>
                    )}
                  />
                  {nextPageToken && (
                    <div style={{ textAlign: 'center', marginTop: 12 }}>
                      <Button loading={loadingFiles} onClick={() => void loadFiles(browseFolderId!, nextPageToken, true)}>
                        {t.connectors.loadMore}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </Card>
      </div>

      <Modal
        title={<span style={titleStyle}>{t.connectors.addTitle}</span>}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false)
          form.resetFields()
        }}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText={t.common.save}
        cancelText={t.common.cancel}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          style={formStyle}
          onFinish={(values) => void handleCreate(values)}
        >
          <Alert
            type="info"
            showIcon
            message={t.connectors.publicLinkInfo}
            style={{ marginBottom: 16 }}
          />

          <Form.Item
            name="name"
            label={<span style={labelStyle}>{t.connectors.nameLabel}</span>}
            rules={[{ required: true, message: t.connectors.nameRequired }]}
          >
            <Input placeholder={t.connectors.namePlaceholder} />
          </Form.Item>

          <Form.Item
            name="folder_input"
            label={<span style={labelStyle}>{t.connectors.folderLabel}</span>}
            rules={[{ required: true, message: t.connectors.folderRequired }]}
            extra={t.connectors.folderHint}
          >
            <Input placeholder="https://drive.google.com/drive/folders/15V2YIi6eUwTKTWZ2Xd9A7Aflsl3Zp6Rh?usp=sharing" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!bulkProgress}
        footer={null}
        closable={false}
        centered
        title={t.connectors.downloadAllProgress}
      >
        <Progress
          percent={
            bulkProgress
              ? Math.round((bulkProgress.current / Math.max(bulkProgress.total, 1)) * 100)
              : 0
          }
          status="active"
        />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {bulkProgress
            ? `${bulkProgress.current} / ${bulkProgress.total}`
            : ''}
        </Typography.Text>
      </Modal>
    </div>
  )
}
