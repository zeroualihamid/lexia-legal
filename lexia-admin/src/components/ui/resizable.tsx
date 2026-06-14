import * as React from "react"
import { GripVertical } from "lucide-react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = React.forwardRef(({
  className,
  orientation = "horizontal",
  ...props
}, ref) => (
  <Group
    groupRef={ref}
    orientation={orientation}
    className={cn(
      "flex h-full w-full",
      orientation === "vertical" ? "flex-col" : "flex-row",
      className
    )}
    {...props} />
))
ResizablePanelGroup.displayName = "ResizablePanelGroup"

const ResizablePanel = React.forwardRef((props, ref) => (
  <Panel {...props} panelRef={ref} />
))
ResizablePanel.displayName = "ResizablePanel"

const ResizableHandle = React.forwardRef(({
  withHandle,
  className,
  ...props
}, ref) => (
  <Separator
    elementRef={ref}
    className={cn(
      "relative flex items-center justify-center bg-transparent transition-all",
      "data-[orientation=horizontal]:w-1 data-[orientation=horizontal]:cursor-col-resize",
      "data-[orientation=vertical]:h-1 data-[orientation=vertical]:cursor-row-resize",
      "hover:bg-primary/20 hover:scale-x-125 focus:bg-primary/30",
      className
    )}
    {...props}>
    {withHandle && (
      <div
        className="z-10 flex h-6 w-4 items-center justify-center rounded-md border border-border bg-muted shadow-sm group-hover:bg-blue-500/10 group-hover:border-blue-500/50 transition-all">
        <GripVertical className="h-3 w-3 text-muted-foreground group-hover:text-blue-500" />
      </div>
    )}
  </Separator>
))
ResizableHandle.displayName = "ResizableHandle"

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
