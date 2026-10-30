import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { PipelinePage } from '../components/PipelinePage.tsx';
import { searchText } from '../lib/source-routes.tsx';

const SearchSchema = v.object({
  repo: searchText,
  target: v.optional(searchText, ''),
  job: v.optional(searchText),
  step: v.optional(searchText),
});

export const Route = createFileRoute('/local_/pipeline')({
  validateSearch: (search) => v.parse(SearchSchema, search),
  component: LocalPipeline,
});

function LocalPipeline() {
  const { repo, target, job, step } = Route.useSearch();
  return <PipelinePage sourceRef={{ kind: 'local', repo, target }} jobId={job} stepId={step} />;
}
