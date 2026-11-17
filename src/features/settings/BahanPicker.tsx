import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Plus, Search } from "lucide-react";
import type { StockItem } from "../../domain/types";
import { rupiah } from "../../domain/calculate";

// Figma "Recipe: search an ingredient" (Manager 4): type to find a bahan by its name or a nama lain, narrow the list
// to an area or to Prep, see each one's unit and last purchase price, and pick it with the keyboard or a tap. A bahan
// already in the recipe stays listed but can't be picked twice; one that doesn't exist yet is added from the list's foot.
export function BahanPicker({ items, value, onChange, label = "Bahan", used = [], costs, onNew, inputRef, drop = "up" }: {
  items: StockItem[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  used?: string[];
  costs?: Map<string, number>;
  onNew?: (name: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  drop?: "up" | "down";
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const picked = items.find((s) => s.id === value);
  const [text, setText] = useState(picked?.name ?? "");
  const [open, setOpen] = useState(false);
  // Upward over the recipe table, as drawn, when there is room above; downward otherwise (a short page, a dialog).
  const [up, setUp] = useState(drop === "up");
  function show() {
    if (!open) setUp(drop === "up" && (box.current?.getBoundingClientRect().top ?? 0) > 400);
    setOpen(true);
  }
  const [group, setGroup] = useState("");
  const [active, setActive] = useState(0);
  // The parent clears the pick after adding a line, or sets one when a recipe row is opened to change its amount (or a
  // new bahan, which reaches the list a moment after it is saved); the text follows. A pick cleared by typing here keeps
  // what is being typed.
  const typed = useRef(false);
  useEffect(() => {
    if (typed.current) typed.current = false;
    else setText(picked?.name ?? "");
  }, [value, picked?.name]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const groupOf = (s: StockItem) => (s.production ? "Prep" : s.area || "");
  const groups = useMemo(() => [...new Set(items.map(groupOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id")), [items]);
  const words = (picked && text === picked.name ? "" : text).toLowerCase().split(/\s+/).filter(Boolean);
  const hits = useMemo(
    () =>
      items
        .filter((s) => (!group || groupOf(s) === group) && words.every((w) => [s.name, ...(s.aliases ?? [])].some((n) => n.toLowerCase().includes(w))))
        // A name that starts with what was typed comes first ("sa" → Salt before Kecap asin).
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(words[0] ?? "")) - Number(!b.name.toLowerCase().startsWith(words[0] ?? "")) || a.name.localeCompare(b.name, "id")),
    [items, group, words.join(" ")],
  );
  const taken = (s: StockItem) => used.includes(s.id);
  function pick(s?: StockItem) {
    if (!s || taken(s)) return;
    onChange(s.id);
    setText(s.name);
    setOpen(false);
  }
  function move(step: number) {
    if (!open) return show();
    for (let i = active + step; i >= 0 && i < hits.length; i += step) if (!taken(hits[i])) return setActive(i);
  }
  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && open) { e.preventDefault(); pick(hits[active]); }
    else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
  }
  useEffect(() => { if (open) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" }); }, [open, active, id]);
  const price = (s: StockItem) => (costs?.has(s.id) ? `${rupiah(Math.round(costs.get(s.id)! * 1000))} / ${s.unit}` : "");
  return (
    <div className="field bahan-picker" ref={box}>
      <span className="field-label" id={`${id}-label`}>{label}</span>
      <div className="bahan-search">
        <Search size={16} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-labelledby={`${id}-label`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && hits[active] ? `${id}-opt-${active}` : undefined}
          placeholder="Cari bahan atau prep"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            show();
            setActive(0);
            if (value) {
              typed.current = true;
              onChange("");
            }
          }}
          onClick={show}
          onKeyDown={keys}
        />
      </div>
      {open && (
        <div className={`bahan-menu ${up ? "up" : "down"}`}>
          {groups.length > 0 && (
            <div className="bahan-chips" role="group" aria-label="Saring bahan">
              {["", ...groups].map((g) => (
                <button key={g || "all"} type="button" aria-pressed={group === g} onPointerDown={(e) => e.preventDefault()} onClick={() => { setGroup(g); setActive(0); }}>
                  {g || "Semua"}
                </button>
              ))}
            </div>
          )}
          <p className="bahan-count">{words.length ? `${hits.length} dari ${items.length} bahan cocok dengan "${text.trim()}"` : `${hits.length} bahan`}</p>
          <ul className="bahan-list" id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}>
            {hits.map((s, i) => (
              <li
                key={s.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={s.id === value}
                aria-disabled={taken(s) || undefined}
                className={`bahan-option${i === active ? " active" : ""}`}
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={() => !taken(s) && setActive(i)}
                onClick={() => pick(s)}
              >
                <span>
                  <strong>{s.name}</strong>
                  <small>{[groupOf(s), s.unit].filter(Boolean).join(" · ")}</small>
                </span>
                <span>{taken(s) ? "Sudah di resep" : price(s)}</span>
              </li>
            ))}
          </ul>
          {!hits.length && <p className="bahan-empty">Tidak ada bahan yang cocok.</p>}
          {onNew && (
            <button type="button" className="text-button bahan-new" onPointerDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); onNew(picked ? "" : text.trim()); }}>
              <Plus size={14} /> Belum ada? Tambah bahan baru
            </button>
          )}
        </div>
      )}
    </div>
  );
}
