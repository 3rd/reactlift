/* eslint-disable no-param-reassign */
import { vi } from "vitest";
import { createStore, useStore } from "./store";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";

const createSimpleStore = () =>
  createStore({
    top: 2,
    arr: [1, 2, 3],
    nested: {
      a: 3,
      b: 5,
      get doubleTop() {
        // can't reach the upper scope, only the local one with `this`
        return 0;
      },
      increaseTop() {
        // can't reach the upper scope, only the local one with `this`
      },
    },
    get doubleA() {
      return this.nested.a * 2;
    },
    increaseNestedA(amount = 1) {
      this.nested.a += amount;
    },
    toDelete: 1 as number | undefined,
    deleteMe() {
      delete this.toDelete;
    },
  });

const createSelfReferencingStoreWithRootArg = () => {
  // `root` should be infered from the return type, but we don't have that in TS yet.
  // - https://github.com/microsoft/TypeScript/issues/49618
  // - https://github.com/microsoft/TypeScript/issues/56311

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore((root: any) => ({
    top: 2,
    arr: [1, 2, 3],
    nested: {
      a: 3,
      b: 5,
      get doubleTop() {
        return root.top * 2;
      },
      increaseTop() {
        root.top = 3;
      },
    },
    get doubleA() {
      return root.nested.a * 2;
    },
    increaseNestedA(amount = 1) {
      root.nested.a += amount;
    },
    toDelete: 1 as number | undefined,
    deleteMe() {
      delete root.toDelete;
    },
  }));
};

const createSelfReferencingStoreWithStoreInstance = () => {
  type Store = {
    top: number;
    arr: number[];
    nested: {
      a: number;
      b: number;
      doubleTop: number;
      increaseTop: () => void;
    };
    doubleA: number;
    increaseNestedA: (amount?: number) => void;
    toDelete: number | undefined;
    deleteMe: () => void;
  };
  const store = createStore({
    top: 2,
    arr: [1, 2, 3],
    nested: {
      a: 3,
      b: 5,
      get doubleTop() {
        return store.state.top * 2;
      },
      increaseTop() {
        store.state.top++;
      },
    },
    get doubleA() {
      return store.state.nested.a * 2;
    },
    increaseNestedA(amount = 1) {
      store.state.nested.a += amount;
    },
    toDelete: 1 as number | undefined,
    deleteMe() {
      delete store.state.toDelete;
    },
  } as Store);
  return store;
};

const useStoreWithRenderCount = (store: ReturnType<typeof createSimpleStore>) => {
  const innerStore = useStore(store);
  const count = useRef(0);
  count.current++;
  return { count: count.current, store: innerStore };
};

describe("createStore", () => {
  it("creates a store with the given initial state", () => {
    const initialState = { count: 0 };
    const store = createStore(initialState);

    expect(store.state).toEqual(initialState);
  });

  it("calls registered callbacks", () => {
    const initialState: { count?: number } = { count: 0 };
    const store = createStore(initialState);

    const callbacks = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    store.subscribe("get", callbacks.get);
    store.subscribe("set", callbacks.set);
    store.subscribe("delete", callbacks.delete);

    expect(callbacks.get).toHaveBeenCalledTimes(0);
    expect(store.state.count).toEqual(0);
    expect(callbacks.get).toHaveBeenCalledTimes(1);

    expect(callbacks.set).toHaveBeenCalledTimes(0);
    store.state.count = 1;
    expect(callbacks.set).toHaveBeenCalledTimes(1);

    expect(callbacks.delete).toHaveBeenCalledTimes(0);
    delete store.state.count;
    expect(callbacks.delete).toHaveBeenCalledTimes(1);
  });
});

const storeDefinitions = [
  { type: "simple", create: createSimpleStore },
  { type: "self-ref-root-arg", create: createSelfReferencingStoreWithRootArg },
  { type: "self-ref-store-instance", create: createSelfReferencingStoreWithStoreInstance },
];

for (const { type, create } of storeDefinitions) {
  describe(`with ${type} definition`, () => {
    describe("createStore", () => {
      it("resolves computed properties (scope)", () => {
        const store = create();

        expect(store.state.nested.a).toEqual(3);
        expect(store.state.doubleA).toEqual(6);

        store.state.nested.a = 10;
        expect(store.state.nested.a).toEqual(10);
        expect(store.state.doubleA).toEqual(20);
      });

      it("handles state actions (scope)", () => {
        const store = create();

        expect(store.state.nested.a).toEqual(3);

        store.state.increaseNestedA();
        expect(store.state.nested.a).toEqual(4);
      });

      it("handles deletions (scope)", () => {
        const store = create();

        expect(store.state.toDelete).toEqual(1);

        delete store.state.toDelete;
        expect(store.state.toDelete).toEqual(undefined);
      });

      if (type !== "simple") {
        it("resolves computed properties (root)", () => {
          const store = create();

          expect(store.state.nested.doubleTop).toEqual(4);
          store.state.top = 10;
          expect(store.state.nested.doubleTop).toEqual(20);
        });

        it("processes actions (root)", () => {
          const store = create();

          expect(store.state.top).toEqual(2);

          store.state.nested.increaseTop();
          expect(store.state.top).toEqual(3);
        });
      }
    });

    describe("useStore", () => {
      it("returns the current state of the store", () => {
        const store = create();

        const { result } = renderHook(() => useStore(store));

        expect(result.current).toEqual(store.state);
      });

      it("subscribes and unsubscribes to the store", () => {
        const store = create();

        const originalSubscribe = store.subscribe;
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        let unsubscribe = () => {};
        const subscribe = vi.fn((...args: unknown[]) => {
          unsubscribe = vi.fn(originalSubscribe(...(args as Parameters<typeof originalSubscribe>)));
          return unsubscribe;
        });
        vi.spyOn(store, "subscribe").mockImplementation(subscribe);

        const { unmount } = renderHook(() => useStore(store));
        expect(unsubscribe).toHaveBeenCalledTimes(0);

        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
      });

      it("rerenders when accessed data changes", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.nested.a
        expect(result.current.store.nested.a).toEqual(3);
        expect(result.current.count).toEqual(1);

        // mutate store.nested.a
        act(() => {
          store.state.nested.a = 100;
        });
        expect(result.current.store.nested.a).toEqual(100);
        expect(result.current.count).toEqual(2);
      });

      it("does not rerender when data that was not accessed changes", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.nested.a
        expect(result.current.store.nested.a).toEqual(3);
        expect(result.current.count).toEqual(1);

        // mutate store.nested.b
        act(() => {
          store.state.nested.b = 100;
        });
        expect(result.current.count).toEqual(1);
      });

      it("rerenders when accessed data is deleted", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.arr
        expect(result.current.store.toDelete).toEqual(1);
        expect(result.current.count).toEqual(1);

        // delete item
        act(() => {
          delete store.state.toDelete;
        });
        expect(result.current.store.toDelete).toEqual(undefined);
        expect(result.current.count).toEqual(2);
      });

      it("does not rerender when data that was not accessed is deleted", () => {
        const store = create();

        const { result } = renderHook(() => useStoreWithRenderCount(store));
        expect(result.current.count).toEqual(1);

        // access store.arr
        expect(result.current.store.top).toEqual(2);
        expect(result.current.count).toEqual(1);

        // delete item
        act(() => {
          delete store.state.toDelete;
        });
        expect(result.current.count).toEqual(1);
      });

      if (type !== "self-ref-store-instance") {
        it("rerenders when accessed computed data's dependencies change", () => {
          const store = create();

          const { result } = renderHook(() => useStoreWithRenderCount(store));
          expect(result.current.count).toEqual(1);

          // access store.doubleA
          expect(result.current.store.doubleA).toEqual(6);
          expect(result.current.count).toEqual(1);

          // mutate store.nested.a
          act(() => {
            store.state.nested.a = 100;
          });
          expect(result.current.store.doubleA).toEqual(200);
          console.log(store.state.doubleA);
          expect(result.current.count).toEqual(2);
        });
      }
    });
  });
}