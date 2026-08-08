type Tone = 'idle' | 'running' | 'success' | 'warning' | 'error';

export function StatusBadge({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`status ${tone}`}>{children}</span>;
}
