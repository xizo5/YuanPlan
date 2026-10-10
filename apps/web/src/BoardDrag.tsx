import type { ReactNode } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconGripVertical } from '@tabler/icons-react';
import type { Task, TaskStatus } from '@yuanplan/contracts';
export function BoardDrag({children,move}:{children:ReactNode;move:(id:string,target:string)=>void}) {
 const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:6}}),useSensor(KeyboardSensor));
 return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({active,over})=>{if(over&&active.id!==over.id)move(String(active.id),String(over.id));}} accessibility={{screenReaderInstructions:{draggable:'按空格开始移动任务，方向键移动，再按空格放置，Escape 取消。'}}}>{children}</DndContext>;
}
export function DropColumn({status,children}:{status:TaskStatus;children:ReactNode}) {const {setNodeRef,isOver}=useDroppable({id:status});return <section ref={setNodeRef} className={`board-column column-${status}${isOver?' drag-over':''}`}>{children}</section>;}
export function DragTask({task,disabled,children}:{task:Task;disabled:boolean;children:ReactNode}) {const {attributes,listeners,setNodeRef,transform,isDragging}=useDraggable({id:task.id,disabled});const drop=useDroppable({id:task.id,disabled});return <div ref={node=>{setNodeRef(node);drop.setNodeRef(node);}} className="draggable-task" data-dragging={isDragging||undefined} style={{transform:transform?`translate3d(${transform.x}px,${transform.y}px,0)`:undefined,zIndex:isDragging?10:undefined,opacity:isDragging?.7:1,outline:drop.isOver?'2px solid var(--mantine-color-forest-5)':undefined}}>{children}{!disabled&&<Tooltip label="拖动" position="top" withArrow openDelay={250} disabled={isDragging} events={{hover:true,focus:true,touch:false}}><ActionIcon className="drag-handle" variant="subtle" color="gray" size={28} aria-label={`移动任务 ${task.title}`} {...attributes} {...listeners}><IconGripVertical size={18}/></ActionIcon></Tooltip>}</div>;}
