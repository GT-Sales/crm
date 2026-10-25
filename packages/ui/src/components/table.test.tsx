import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

describe('Table', () => {
  it('renders semantic sections, headers and cells inside a scroll container', () => {
    render(
      <Table>
        <TableCaption>Orders submitted this week</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Plan</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>CP-1001</TableCell>
            <TableCell>Single entry</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell>1</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    );

    const table = screen.getByRole('table');
    expect(table.tagName).toBe('TABLE');
    expect(table.getAttribute('data-slot')).toBe('table');
    expect(table.parentElement?.getAttribute('data-slot')).toBe('table-container');

    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('columnheader', { name: 'Order' }).getAttribute('data-slot')).toBe(
      'table-head',
    );
    expect(screen.getByRole('cell', { name: 'CP-1001' }).getAttribute('data-slot')).toBe(
      'table-cell',
    );
    expect(screen.getByText('Orders submitted this week').tagName).toBe('CAPTION');
  });

  it('keeps caller classNames and forwards plain HTML attributes', () => {
    render(
      <Table aria-label="Documents" className="mt-4">
        <TableBody>
          <TableRow data-state="selected" className="bg-muted">
            <TableCell>Passport scan</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const table = screen.getByRole('table', { name: 'Documents' });
    expect(table.className).toContain('mt-4');
    expect(table.className).toContain('w-full');

    const row = screen.getByRole('row');
    expect(row.getAttribute('data-state')).toBe('selected');
    expect(row.className).toContain('bg-muted');
  });
});
