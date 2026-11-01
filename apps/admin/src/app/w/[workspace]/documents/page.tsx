import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
import Link from 'next/link';
import { FileCheck2Icon, UploadCloudIcon, ShieldCheckIcon, ArrowUpRightIcon } from 'lucide-react';

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Review customer files alongside the lead and its order requirements.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2 className="flex items-center gap-2">
              <FileCheck2Icon className="size-5 text-muted-foreground" />
              Document review
            </h2>
          </CardTitle>
          <CardDescription>
            Each lead keeps its uploads, review history and required documents together.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-5 text-sm text-muted-foreground">
          <p>
            Open a lead and use its Documents card to review passport, visa and other files. Approve
            the required documents before moving an order through a documents check.
          </p>
          <Link
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground"
            href={`/w/${workspace}/leads`}
          >
            Open leads
            <ArrowUpRightIcon className="size-4" />
          </Link>
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          {
            icon: UploadCloudIcon,
            title: 'Uploads stay with the lead',
            text: 'Customer files are attached to the matching enquiry or order, including approved change requests.',
          },
          {
            icon: ShieldCheckIcon,
            title: 'Review before progressing',
            text: 'The order’s frozen plan determines which document types need approval. Review and download actions follow your staff permissions.',
          },
        ].map(({ icon: Icon, title, text }) => (
          <Card key={title}>
            <CardContent className="flex flex-col gap-3">
              <Icon className="size-5 text-muted-foreground" />
              <h2 className="font-medium">{title}</h2>
              <p className="text-sm text-muted-foreground">{text}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
