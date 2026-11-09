import { greet } from "./lib/greet";

document.querySelector<HTMLDivElement>("#app")!.textContent = greet("webapp-template");
