import { randomUUID } from "node:crypto";
import { validate } from "./validation.js";

export class Service {
  constructor(name = "private-name") {
    this.name = name;
  }

  run(value) {
    randomUUID();
    validate(value);
    dependency.process(value);
  }
}

export function createService() {
  return new Service("private-constructor-value");
}
