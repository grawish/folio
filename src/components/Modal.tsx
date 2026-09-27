import { useEffect, useId, useRef, type ReactNode } from 'react';
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
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const el = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.showModal();
    return () => {
      // Unmounting a native dialog can leave focus on the page body. Restore
      // its opener unless another part of the workflow has already taken focus.
      const restore =
        el?.contains(document.activeElement) || document.activeElement === document.body;
      el?.close();
      if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      className={`modal ${wide ? 'modal-wide' : ''} ${className}`}
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-modal="true"
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
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
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
