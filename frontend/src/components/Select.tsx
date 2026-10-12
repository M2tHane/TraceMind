import { useState } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'

export interface SelectOption { value: string; label: string; disabled?: boolean }
interface SelectProps {
  options: SelectOption[]
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  name?: string
  label: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
  className?: string
  contentClassName?: string
}
export function Select({ options, value, defaultValue, onChange, name, label, placeholder = '请选择', disabled, required, className = '', contentClassName = '' }: SelectProps) {
  const [open, setOpen] = useState(false)
  return <SelectPrimitive.Root open={open} onOpenChange={setOpen} value={value} defaultValue={defaultValue} onValueChange={onChange} name={name} disabled={disabled} required={required}>
    <SelectPrimitive.Trigger className={`select-trigger ${className}`} aria-label={label}>
      <SelectPrimitive.Value placeholder={placeholder} />
      <SelectPrimitive.Icon className="select-icon"><ChevronDown size={15} /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className={`select-content ${contentClassName}`} position="popper" sideOffset={5} collisionPadding={12} onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}>
        <SelectPrimitive.ScrollUpButton className="select-scroll"><ChevronUp size={15} /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="select-viewport">
          {options.map(option => <SelectPrimitive.Item className="select-item" key={option.value} value={option.value} disabled={option.disabled}>
            <SelectPrimitive.ItemIndicator className="select-check"><Check size={14} /></SelectPrimitive.ItemIndicator>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="select-scroll"><ChevronDown size={15} /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}
