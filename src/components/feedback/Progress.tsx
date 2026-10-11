export function Progress({ text, percent }: { text: string; percent?: number }) {
  return (
    <div className="progress">
      <div className={`progress-bar ${percent === undefined ? '' : 'is-determinate'}`} role={percent === undefined ? undefined : 'progressbar'} aria-valuemin={percent === undefined ? undefined : 0} aria-valuemax={percent === undefined ? undefined : 100} aria-valuenow={percent} style={percent === undefined ? undefined : { width: `${percent}%`, animation: 'none', transform: 'none' }} />
      <p className="progress-text">{text}</p>
    </div>
  );
}
