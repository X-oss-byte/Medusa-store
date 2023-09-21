"use client"

import { clx } from "@medusajs/ui"
import * as Primitives from "@radix-ui/react-scroll-area"
import clsx from "clsx"

type ScrollbarProps = React.ComponentProps<typeof Primitives.Scrollbar>

const Scrollbar = (props: ScrollbarProps) => {
  return (
    <Primitives.Scrollbar
      className={clsx(
        "bg-medusa-bg-base dark:bg-medusa-bg-base-dark flex touch-none select-none p-0.5 transition-colors ease-out",
        "data-[orientation=horizontal]:h-2.5 data-[orientation=vertical]:w-2.5 data-[orientation=horizontal]:flex-col"
      )}
      {...props}
    />
  )
}

type ThumbProps = React.ComponentProps<typeof Primitives.Thumb>

const Thumb = ({ className, ...props }: ThumbProps) => {
  return (
    <Primitives.Thumb
      className={clx(
        "bg-medusa-bg-component dark:bg-medusa-bg-component-dark relative flex-1 rounded-[10px] before:absolute before:left-1/2 before:top-1/2 before:h-full",
        "before:min-h-[44px] before:w-full before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        className
      )}
      {...props}
    />
  )
}

type ScrollAreaProps = React.ComponentProps<typeof Primitives.Root>

const ScrollArea = ({ children, className }: ScrollAreaProps) => {
  return (
    <Primitives.Root
      className={clx("h-full w-full overflow-hidden", className)}
    >
      <Primitives.Viewport className="h-full w-full">
        {children}
      </Primitives.Viewport>
      <Scrollbar orientation="vertical">
        <Thumb />
      </Scrollbar>
      <Scrollbar orientation="horizontal">
        <Thumb />
      </Scrollbar>
      <Primitives.Corner />
    </Primitives.Root>
  )
}

export { ScrollArea }