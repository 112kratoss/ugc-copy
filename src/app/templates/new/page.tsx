import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Create a Template',
};

export default function NewTemplatePage() {
  redirect('/create-workflow?template=new');
}
