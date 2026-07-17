import { describe, it, expect } from "vitest";
import { buildPipelinePreviewTree } from "../../src/web/pipeline-preview.js";

describe("structured pipeline preview (issue #24)", () => {
  it("S1: parses stage, repeat, command, and nesting", () => {
    const yaml = `
name: demo
goal: ship it
stages:
  - name: design
    roles: [designer]
  - repeat:
      name: loop
      max_iterations: 3
      until: ok
      stages:
        - name: implement
          roles: [dev]
        - name: measure
          command: "echo 1"
          gate:
            id: ok
            evidence:
              path: x
              check:
                field: a
                equals: 1
`;
    const tree = buildPipelinePreviewTree(yaml);
    expect(tree.name).toBe("demo");
    expect(tree.goal).toBe("ship it");
    expect(tree.nodes).toHaveLength(2);
    expect(tree.nodes[0]).toMatchObject({ kind: "stage", name: "design", roles: ["designer"] });
    expect(tree.nodes[1].kind).toBe("repeat");
    expect(tree.nodes[1].children).toHaveLength(2);
    expect(tree.nodes[1].children![0].kind).toBe("stage");
    expect(tree.nodes[1].children![1]).toMatchObject({ kind: "command", name: "measure" });
  });
});
