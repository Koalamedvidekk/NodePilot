import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { api } from '../api';
import { Icon } from '../components/Icon';
import type { Server, ServerUsage, ServerUsageSample } from '../types';
import { errorMessage, formatBytes, formatPercent, formatUptime } from '../utils';

type ChartPoint = {
  timestamp: string;
  label: string;
  cpu?: number;
  memoryMb?: number;
  heapMb?: number;
  networkIn?: number;
  networkOut?: number;
};

function isPollingStatus(status: Server['status']): boolean {
  return status === 'running' || status === 'starting' || status === 'stopping';
}

function metricReason(usage: ServerUsage | undefined, metric: 'cpu' | 'memory' | 'heap' | 'disk' | 'network'): string | undefined {
  const capability = usage?.capabilities?.[metric];
  if (capability?.available === false) return capability.reason;
  const current = usage?.current;
  if (metric === 'heap' && current?.heap?.available === false) return current.heap.reason;
  if (metric === 'disk' && current?.disk?.available === false) return current.disk.reason;
  if (metric === 'network' && current?.network?.available === false) return current.network.reason;
  return undefined;
}

function historyToChart(history: ServerUsageSample[]): ChartPoint[] {
  return history.map((sample) => ({
    timestamp: sample.timestamp ?? '',
    label: sample.timestamp ? new Intl.DateTimeFormat(undefined, { minute: '2-digit', second: '2-digit' }).format(new Date(sample.timestamp)) : '',
    cpu: sample.cpuPercent,
    memoryMb: sample.memoryBytes === undefined ? undefined : sample.memoryBytes / (1024 * 1024),
    heapMb: sample.heap?.usedBytes === undefined ? undefined : sample.heap.usedBytes / (1024 * 1024),
    networkIn: sample.network?.receivedBytesPerSecond,
    networkOut: sample.network?.sentBytesPerSecond,
  }));
}

function MetricCard({ title, value, detail, unavailable }: { title: string; value: string; detail: string; unavailable?: boolean }) {
  return <section className={`usage-metric-card ${unavailable ? 'is-unavailable' : ''}`}>
    <span>{title}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </section>;
}

function ChartEmpty({ reason }: { reason?: string }) {
  return <div className="usage-chart-empty"><Icon name="activity" size={18} /><span>{reason ?? 'Waiting for a second process sample…'}</span></div>;
}

function ChartTooltip({ active, payload, label, unit = '' }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string; unit?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="usage-chart-tooltip"><strong>{label}</strong>{payload.filter((entry) => typeof entry.value === 'number').map((entry) => <span key={entry.name} style={{ color: entry.color }}>{entry.name}: {typeof entry.value === 'number' ? entry.value.toFixed(entry.value < 10 ? 1 : 0) : '—'}{unit}</span>)}</div>;
}

export function UsagePanel({ server }: { server: Server }) {
  const [usage, setUsage] = useState<ServerUsage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const next = await api.usage(server.id);
        if (active) {
          setUsage(next);
          setError(undefined);
        }
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        if (active) setLoading(false);
      }
    };

    const startPolling = () => {
      if (timer || !isPollingStatus(server.status) || document.visibilityState === 'hidden') return;
      timer = setInterval(() => void load(), 2_000);
    };
    const stopPolling = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        void load();
        startPolling();
      }
    };

    setUsage(undefined);
    setLoading(true);
    void load();
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [server.id, server.status]);

  const current = usage?.current;
  const chartData = useMemo(() => historyToChart(usage?.history ?? []), [usage?.history]);
  const disk = current?.disk;
  const heap = current?.heap;
  const network = current?.network;
  const cpuUnavailable = metricReason(usage, 'cpu');
  const memoryUnavailable = metricReason(usage, 'memory');
  const heapUnavailable = metricReason(usage, 'heap');
  const diskUnavailable = metricReason(usage, 'disk');
  const networkUnavailable = metricReason(usage, 'network');

  return <section className="usage-panel">
    <div className="usage-heading">
      <div><p className="eyebrow">LIVE PROCESS METRICS</p><h3>Usage</h3><p>Metrics are sampled only from this server’s managed Java process. Nothing is substituted from whole-machine usage.</p></div>
      <span className={`usage-refresh-state ${isPollingStatus(server.status) ? 'is-live' : ''}`}><i /> {isPollingStatus(server.status) ? 'Refreshing every 2 seconds' : 'Server is not running'}</span>
    </div>

    {error && <div className="inline-alert alert-error usage-error" role="alert"><Icon name="warning" size={18} /><div><strong>Usage data is unavailable.</strong><span>{error}</span></div></div>}

    <div className="usage-metric-grid">
      <MetricCard title="CPU" value={current?.cpuPercent === undefined ? 'Unavailable' : formatPercent(current.cpuPercent)} detail={cpuUnavailable ?? 'Share of total logical machine capacity'} unavailable={current?.cpuPercent === undefined} />
      <MetricCard title="Process memory" value={current?.memoryBytes === undefined ? 'Unavailable' : formatBytes(current.memoryBytes)} detail={memoryUnavailable ?? 'Resident memory (RSS), not Java heap'} unavailable={current?.memoryBytes === undefined} />
      <MetricCard title="Java heap" value={heap?.usedBytes === undefined ? 'Unavailable' : formatBytes(heap.usedBytes)} detail={heapUnavailable ?? `${formatBytes(heap?.committedBytes)} committed · ${formatBytes(heap?.maxBytes)} configured`} unavailable={heap?.usedBytes === undefined} />
      <MetricCard title="Server directory" value={disk?.directoryBytes === undefined ? 'Measuring…' : formatBytes(disk.directoryBytes)} detail={diskUnavailable ?? `I/O ${formatBytes(disk?.readBytesPerSecond)}/s read · ${formatBytes(disk?.writeBytesPerSecond)}/s write`} unavailable={disk?.directoryBytes === undefined} />
      <MetricCard title="Network" value={network?.receivedBytesPerSecond === undefined && network?.sentBytesPerSecond === undefined ? 'Unavailable' : `${formatBytes(network.receivedBytesPerSecond)}/s`} detail={networkUnavailable ?? `${formatBytes(network?.sentBytesPerSecond)}/s sent`} unavailable={network?.receivedBytesPerSecond === undefined && network?.sentBytesPerSecond === undefined} />
      <MetricCard title="Uptime" value={current?.uptimeMs === undefined ? 'Unavailable' : formatUptime(current.uptimeMs / 1_000)} detail={current?.timestamp ? `Sampled ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(current.timestamp))}` : 'No managed process sample yet'} unavailable={current?.uptimeMs === undefined} />
    </div>

    <div className="usage-chart-grid">
      <section className="panel usage-chart-card"><div className="panel-heading"><div><h3>CPU activity</h3><p>Process CPU normalized across all logical CPUs.</p></div></div>{chartData.length > 1 ? <div className="usage-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><defs><linearGradient id="cpuFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#8d77ff" stopOpacity={0.42} /><stop offset="100%" stopColor="#8d77ff" stopOpacity={0} /></linearGradient></defs><CartesianGrid vertical={false} stroke="rgba(255,255,255,.08)" /><XAxis dataKey="label" minTickGap={36} tickLine={false} axisLine={false} /><YAxis unit="%" width={38} tickLine={false} axisLine={false} /><Tooltip content={<ChartTooltip unit="%" />} /><Area type="monotone" dataKey="cpu" name="CPU" stroke="#9d8bff" fill="url(#cpuFill)" strokeWidth={2} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div> : <ChartEmpty reason={loading ? 'Collecting the first process sample…' : cpuUnavailable} />}</section>
      <section className="panel usage-chart-card"><div className="panel-heading"><div><h3>Memory and heap</h3><p>RSS is measured from the process; heap needs Java’s local jcmd tool.</p></div></div>{chartData.length > 1 ? <div className="usage-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData}><CartesianGrid vertical={false} stroke="rgba(255,255,255,.08)" /><XAxis dataKey="label" minTickGap={36} tickLine={false} axisLine={false} /><YAxis unit=" MB" width={52} tickLine={false} axisLine={false} /><Tooltip content={<ChartTooltip unit=" MB" />} /><Legend /><Line type="monotone" dataKey="memoryMb" name="Process RSS" stroke="#66d8bb" strokeWidth={2} dot={false} isAnimationActive={false} /><Line type="monotone" dataKey="heapMb" name="Java heap" stroke="#f6bf61" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <ChartEmpty reason={loading ? 'Collecting the first process sample…' : memoryUnavailable ?? heapUnavailable} />}</section>
      <section className="panel usage-chart-card usage-network-card"><div className="panel-heading"><div><h3>Network activity</h3><p>Per-process network accounting is shown only when a reliable host collector is available.</p></div></div>{chartData.some((point) => point.networkIn !== undefined || point.networkOut !== undefined) ? <div className="usage-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData}><CartesianGrid vertical={false} stroke="rgba(255,255,255,.08)" /><XAxis dataKey="label" minTickGap={36} tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} /><Tooltip content={<ChartTooltip unit=" B/s" />} /><Legend /><Line type="monotone" dataKey="networkIn" name="Received" stroke="#69c8ff" strokeWidth={2} dot={false} isAnimationActive={false} /><Line type="monotone" dataKey="networkOut" name="Sent" stroke="#d891ff" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <ChartEmpty reason={networkUnavailable ?? 'No reliable per-process network collector is available on this host.'} />}</section>
    </div>
    <p className="usage-footnote">History is retained in memory for this NodePilot session only (up to 300 samples, about 10 minutes while this tab is open). Stopping NodePilot never reattaches metrics to an old PID.</p>
  </section>;
}
