import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className={`sheet-content ${wide ? "sheet-wide" : ""}`}>
          <div className="sheet-header">
            <div>
              <span className="eyebrow">WORKSPACE / DETAIL</span>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>
                {description || "当前筛选范围内的数据与操作详情"}
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭抽屉">
              <X size={20} />
            </Dialog.Close>
          </div>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
