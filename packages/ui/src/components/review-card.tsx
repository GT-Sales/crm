import * as React from 'react';

import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';

export interface ReviewCardProps {
  title: string;
  children: React.ReactNode;
  onEdit?: () => void;
  editLabel?: string;
}

/**
 * Read-only summary block for the order review step. The edit action is
 * rendered only when `onEdit` is supplied, so a card can also be a plain
 * summary. Free of server-only imports: it is rendered inside a client
 * component.
 */
function ReviewCard({ title, children, onEdit, editLabel = 'Edit' }: ReviewCardProps) {
  return (
    <Card data-slot="review-card">
      <CardHeader>
        <CardTitle asChild>
          <h3>{title}</h3>
        </CardTitle>
        {onEdit ? (
          <div data-slot="card-action">
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              {editLabel}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export { ReviewCard };
