/**
 * Ambient declarations for the browser module table this client half is built
 * against.
 *
 * WHY THIS FILE EXISTS
 * The bundle imports `react`, `react/jsx-runtime` and
 * `@deepseek-ai/dsh-client-ui-primitives` at runtime through
 * `window.__ModuleLoader__`'s module table; none of them are dependencies of
 * this repository (the server package ships host code, and `tsdown.client.config.mjs`
 * keeps only the platform module table external). They are therefore absent from
 * `node_modules` and `tsc --noEmit` would report TS2307 for every import. This
 * file supplies the minimal shapes those modules expose so the browser half
 * type-checks here.
 *
 * It is a stand-in, not the contract: the authoritative types live in the DSH
 * checkout. Only the surface `src/client/**` uses is declared; primitive props
 * are intentionally loose so shell-native attributes (`data-*`, `aria-*`, event
 * handlers) pass through unchecked.
 */

/* -------------------------------------------------------------------------
 * react
 * ---------------------------------------------------------------------- */

declare module 'react' {
  export type Key = string | number

  /** Minimal element shape; only enough for `ReactNode` composition. */
  export interface ReactElement {
    type: unknown
    props: unknown
    key: Key | null
  }

  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | Iterable<ReactNode>

  export type SetStateAction<S> = S | ((previous: S) => S)
  export type Dispatch<A> = (value: A) => void

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T
  export function useCallback<T>(callback: T, deps?: readonly unknown[]): T
  export function useSyncExternalStore<S>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => S,
    getServerSnapshot?: () => S,
  ): S
}

/* -------------------------------------------------------------------------
 * react/jsx-runtime — the automatic JSX entry (`jsx: react-jsx`)
 * ---------------------------------------------------------------------- */

declare module 'react/jsx-runtime' {
  export namespace JSX {
    interface Element {
      type: unknown
      props: unknown
      key: string | number | null
    }
    interface ElementClass {
      render(): unknown
    }
    interface ElementAttributesProperty {
      props: unknown
    }
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicAttributes {
      key?: string | number | null
    }
    /** Intrinsic tags accept every attribute; the shell owns their real props. */
    interface IntrinsicElements {
      [elementName: string]: any
    }
  }

  export const Fragment: any
  export function jsx(type: any, props: any, key?: any): JSX.Element
  export function jsxs(type: any, props: any, key?: any): JSX.Element
  export function jsxDEV(type: any, props: any, key?: any, isStatic?: any, source?: any, self?: any): JSX.Element
}

/* -------------------------------------------------------------------------
 * @deepseek-ai/dsh-client-ui-primitives
 * ---------------------------------------------------------------------- */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export interface IconProps {
    size?: number | undefined
    className?: string | undefined
  }

  export type IconComponent = (props: IconProps) => any

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    disabled?: boolean
    title?: string
    children?: ReactNode
    [attribute: string]: any
  }): any

  export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

  export function StateDot(props: {
    state: StateDotState
    size?: number | undefined
    className?: string | undefined
    appearance?: 'dot' | 'step'
  }): any

  /* Icons used by this client half (the module re-exports the full set). */
  export const IconGlobeOutlineRegular: IconComponent
  export const IconPlusOutlineRegular: IconComponent
  export const IconRefreshOutlineRegular: IconComponent
  export const IconChevronLeftOutlineRegular: IconComponent
  export const IconWarningTriangleOutlineRegular: IconComponent
}
