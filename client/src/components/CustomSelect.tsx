import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export interface CustomSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CustomSelectOption | string>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  variant?: 'purple' | 'cyan' | 'default';
  onOpenChange?: (isOpen: boolean) => void;
}

function normalizeOption(option: CustomSelectOption | string): CustomSelectOption {
  if (typeof option === 'string') {
    return { value: option, label: option };
  }
  return option;
}

export function CustomSelect({
  value,
  onChange,
  options: rawOptions,
  placeholder = 'Select an option…',
  disabled = false,
  className = '',
  id,
  'aria-label': ariaLabel,
  variant = 'purple',
  onOpenChange,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);

  const updateIsOpen = (nextOpen: boolean) => {
    setIsOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);

  const options = rawOptions.map(normalizeOption);
  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        updateIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  // Keep highlighted item in view
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0 || !listboxRef.current) return;
    const item = listboxRef.current.children[highlightedIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, highlightedIndex]);

  const toggleOpen = () => {
    if (disabled) return;
    if (!isOpen) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
      updateIsOpen(true);
    } else {
      updateIsOpen(false);
    }
  };

  const selectOption = (opt: CustomSelectOption) => {
    if (opt.disabled || disabled) return;
    onChange(opt.value);
    updateIsOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (!isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
        updateIsOpen(true);
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        updateIsOpen(false);
        break;
      case 'Tab':
        updateIsOpen(false);
        break;
      case 'ArrowDown': {
        event.preventDefault();
        setHighlightedIndex((prev) => (prev + 1 < options.length ? prev + 1 : 0));
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : options.length - 1));
        break;
      }
      case 'Home': {
        event.preventDefault();
        setHighlightedIndex(0);
        break;
      }
      case 'End': {
        event.preventDefault();
        setHighlightedIndex(options.length - 1);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          selectOption(options[highlightedIndex]);
        }
        break;
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={`custom-select-container variant-${variant} ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className}`}
    >
      <button
        type="button"
        id={id}
        className="custom-select-trigger"
        onClick={toggleOpen}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
      >
        <span className="custom-select-value">
          {selectedOption ? (
            <span className="custom-select-label">{selectedOption.label}</span>
          ) : (
            <span className="custom-select-placeholder">{placeholder}</span>
          )}
        </span>
        <span className="custom-select-chevron" aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>

      {isOpen && (
        <div className="custom-select-dropdown">
          <ul
            ref={listboxRef}
            className="custom-select-listbox"
            role="listbox"
            aria-activedescendant={highlightedIndex >= 0 ? `opt-${highlightedIndex}` : undefined}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              const isHighlighted = index === highlightedIndex;

              return (
                <li
                  key={option.value}
                  id={`opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled}
                  className={`custom-select-option ${isSelected ? 'is-selected' : ''} ${isHighlighted ? 'is-highlighted' : ''} ${option.disabled ? 'is-disabled' : ''}`}
                  onClick={() => selectOption(option)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <div className="custom-select-option-content">
                    <span className="custom-select-option-label">{option.label}</span>
                    {option.description && (
                      <span className="custom-select-option-desc">{option.description}</span>
                    )}
                  </div>
                  {isSelected && (
                    <span className="custom-select-check" aria-hidden="true">
                      <Icon name="check" size={15} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
