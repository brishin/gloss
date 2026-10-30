import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { PipelinePage } from '../components/PipelinePage.tsx';
import { searchText } from '../lib/source-routes.tsx';

const SearchSchema = v.object({ step: v.optional(searchText) });

export const Route = createFileRoute('/gh/$owner/$repo/pull/$number_/pipeline')({
  validateSearch: (search) => v.parse(SearchSchema, search),
  component: GithubPipeline,
});

function GithubPipeline() {
  const { owner, repo, number } = Route.useParams();
  const { step } = Route.useSearch();
  return <PipelinePage sourceRef={{ kind: 'github-pr', owner, repo, number: Number(number) }} stepId={step} />;
}
