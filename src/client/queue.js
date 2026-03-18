export class QueueItem {
  value;
  _expiration;

  constructor(value, expiresIn) {
    this.value = value;
    this._expiration = Date.now() + expiresIn;
  }

  get expiresIn() {
    return this._expiration - Date.now();
  }

  get isExpired() {
    return Date.now() > this._expiration;
  }
}

export class Queue {
  items = [];

  add(item, expiresIn) {
    this.items.push(new QueueItem(item, expiresIn));
  }

  get isEmpty() {
    this.items = this.items.filter((item) => !item.isExpired);
    return this.items.length === 0;
  }

  pop() {
    while (this.items.length > 0) {
      const item = this.items.shift();
      if (item && !item.isExpired) {
        return item;
      }
    }
    return null;
  }

  clear() {
    this.items = [];
  }
}
