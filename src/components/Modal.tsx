import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  dismissible = true,
  className = '',
}: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  dismissible?: boolean;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      className={`modal ${wide ? 'modal-wide' : ''} ${className}`}
      ref={dialog}
      aria-labelledby="modal-title"
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            if (dismissible) onClose();
        }
      }}
    >
      <div className="modal-heading">
        <div>
          <span className="eyebrow">YOUR NEXT CHAPTER</span>
          <h2 id="modal-title">{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
          disabled={!dismissible}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
