import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "end", sideOffset = 6, ...props }, ref) => {
  const scope = usePortalScopeProps();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} {...scope}
        className={cn("z-50 w-80 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none", className)}
        {...props} />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = "PopoverContent";
