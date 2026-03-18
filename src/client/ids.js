export class IdManager {
  usedIds = new Set();
  counter = 0;
  maxCounter;

  constructor(maxCounter = 9999) {
    this.maxCounter = maxCounter;
  }

  release(id) {
    this.usedIds.delete(id);
  }

  reserve() {
    this.counter = (this.counter + 1) % this.maxCounter;
    const timestamp = Date.now() % 10000;
    let id = timestamp * 10000 + this.counter;

    while (this.usedIds.has(id)) {
      id = (id + 1) % (10000 * 10000);
    }

    this.usedIds.add(id);
    return id;
  }
}
