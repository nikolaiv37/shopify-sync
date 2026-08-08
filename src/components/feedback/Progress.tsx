export function Progress({ text }: { text: string }) {
  return (
    <div className="progress">
      <div className="progress-bar" />
      <p className="progress-text">{text}</p>
    </div>
  );
}
