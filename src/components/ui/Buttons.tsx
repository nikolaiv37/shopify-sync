import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  icon?: ReactNode;
};

export function Button({ variant = 'secondary', size = 'md', icon, className = '', children, ...props }: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className].filter(Boolean).join(' ');
  return (
    <button className={classes} type="button" {...props}>
      {icon ? <span className="btn-ico">{icon}</span> : null}
      {children}
    </button>
  );
}
