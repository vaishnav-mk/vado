import { ValkeyShard } from "./shard";

// One object under 16 class names: primaries use class i % classes (0-7), replicas of class k use 8 + k.
export class ValkeyShard1 extends ValkeyShard {
  static override readonly shardClass = 1;
}

export class ValkeyShard2 extends ValkeyShard {
  static override readonly shardClass = 2;
}

export class ValkeyShard3 extends ValkeyShard {
  static override readonly shardClass = 3;
}

export class ValkeyShard4 extends ValkeyShard {
  static override readonly shardClass = 4;
}

export class ValkeyShard5 extends ValkeyShard {
  static override readonly shardClass = 5;
}

export class ValkeyShard6 extends ValkeyShard {
  static override readonly shardClass = 6;
}

export class ValkeyShard7 extends ValkeyShard {
  static override readonly shardClass = 7;
}

export class ValkeyShard8 extends ValkeyShard {
  static override readonly shardClass = 8;
}

export class ValkeyShard9 extends ValkeyShard {
  static override readonly shardClass = 9;
}

export class ValkeyShard10 extends ValkeyShard {
  static override readonly shardClass = 10;
}

export class ValkeyShard11 extends ValkeyShard {
  static override readonly shardClass = 11;
}

export class ValkeyShard12 extends ValkeyShard {
  static override readonly shardClass = 12;
}

export class ValkeyShard13 extends ValkeyShard {
  static override readonly shardClass = 13;
}

export class ValkeyShard14 extends ValkeyShard {
  static override readonly shardClass = 14;
}

export class ValkeyShard15 extends ValkeyShard {
  static override readonly shardClass = 15;
}
