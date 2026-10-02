/**
 * A ref object that reports when it starts or stops holding a value.
 *
 * Shaped like a React ref (`{ current }`), so code that writes `.current`
 * needs no change to be observed. `main.tsx` builds `anim` from one: the
 * render hooks and `useRearrangement.ts` write it from many places, and the
 * camera controls need a re-render each time a rearrangement takes or
 * releases the camera (`docs/agents/rearrangement.md`, "The reorder
 * animation").
 *
 * `onChange` fires synchronously inside the setter, and only when the value
 * crosses between null and non-null; replacing one value with another is
 * silent.
 */
export function presenceRef<T>(onChange: (present: boolean) => void): { current: T | null } {
  let value: T | null = null;
  return {
    get current() {
      return value;
    },
    set current(next: T | null) {
      const was = value != null;
      value = next;
      if (was !== (next != null)) onChange(next != null);
    },
  };
}
