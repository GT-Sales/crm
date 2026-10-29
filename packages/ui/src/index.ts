/**
 * @gt-sales/ui — shared shadcn/ui-based primitives and design tokens.
 * Import `@gt-sales/ui/tokens.css` once per app (root layout) for the
 * colour/radius/spacing/font variables consumed by these components.
 */
export { cn } from './lib/utils';

export { Avatar, AvatarImage, AvatarFallback } from './components/avatar';
export { Badge, badgeVariants, type BadgeProps } from './components/badge';
export { Button, buttonVariants, type ButtonProps } from './components/button';
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from './components/card';
export { Checkbox } from './components/checkbox';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/dialog';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from './components/dropdown-menu';
export { FileDrop, FILE_DROP_DEFAULT_NOTE, type FileDropProps } from './components/file-drop';
export {
  FormField,
  type FormFieldProps,
  type FormFieldControlProps,
} from './components/form-field';
export { Input } from './components/input';
export { NativeSelect } from './components/native-select';
export { Label } from './components/label';
export { ReviewCard, type ReviewCardProps } from './components/review-card';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/select';
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './components/popover';
export { Separator } from './components/separator';
export {
  Sheet,
  SheetClose,
  SheetTrigger,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from './components/sheet';
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './components/sidebar';
export { Skeleton } from './components/skeleton';
export { SkipLink } from './components/skip-link';
export { Stepper, type StepperProps, type StepperStep } from './components/stepper';
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './components/table';
export { Textarea } from './components/textarea';
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './components/tooltip';
export { useIsMobile } from './hooks/use-mobile';
