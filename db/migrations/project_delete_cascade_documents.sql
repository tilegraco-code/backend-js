-- Borrar un agente (DELETE project) fallaba si tenía conocimiento cargado:
-- documents y document_billing_items apuntaban a project sin regla de borrado.
--
-- - documents: se borran con el proyecto (y sus document_chunks ya cascadean).
-- - document_billing_items: son páginas a cobrar → NO se borran; quedan con project_id NULL.
--   (se siguen cobrando por client_id).

begin;

alter table public.documents
  drop constraint documents_project_id_fkey,
  add constraint documents_project_id_fkey
    foreign key (project_id) references public.project(project_id) on delete cascade;

alter table public.document_billing_items
  alter column project_id drop not null,
  drop constraint document_billing_items_project_id_fkey,
  add constraint document_billing_items_project_id_fkey
    foreign key (project_id) references public.project(project_id) on delete set null;

commit;
