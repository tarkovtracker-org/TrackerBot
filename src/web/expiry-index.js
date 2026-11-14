// Indexed min-heap: at most one deadline per live client, with no stale nodes.
// Updates/deletes are O(log n); inspecting the earliest expiry is O(1).
export class ExpiryIndex {
  #heap = [];
  #positions = new Map();

  get size() { return this.#heap.length; }

  set(key, time) {
    if (!Number.isFinite(time)) throw new TypeError("Expiry must be finite");
    const position = this.#positions.get(key);
    if (position === undefined) {
      this.#positions.set(key, this.#heap.length);
      this.#heap.push({ key, time });
    } else {
      this.#heap[position].time = time;
    }
    this.#up(this.#positions.get(key));
    this.#down(this.#positions.get(key));
  }

  delete(key) {
    const position = this.#positions.get(key);
    if (position === undefined) return;
    const last = this.#heap.pop();
    this.#positions.delete(key);
    if (position < this.#heap.length) {
      this.#heap[position] = last;
      this.#positions.set(last.key, position);
      this.#up(position);
      this.#down(this.#positions.get(last.key));
    }
  }

  popExpired(time) {
    const first = this.#heap[0];
    if (!first || first.time > time) return null;
    this.delete(first.key);
    return first;
  }

  #swap(left, right) {
    [this.#heap[left], this.#heap[right]] = [this.#heap[right], this.#heap[left]];
    this.#positions.set(this.#heap[left].key, left);
    this.#positions.set(this.#heap[right].key, right);
  }

  #up(position) {
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (this.#heap[parent].time <= this.#heap[position].time) return;
      this.#swap(parent, position);
      position = parent;
    }
  }

  #down(position) {
    while (position * 2 + 1 < this.#heap.length) {
      let child = position * 2 + 1;
      const right = child + 1;
      if (right < this.#heap.length && this.#heap[right].time < this.#heap[child].time) child = right;
      if (this.#heap[position].time <= this.#heap[child].time) return;
      this.#swap(position, child);
      position = child;
    }
  }
}
