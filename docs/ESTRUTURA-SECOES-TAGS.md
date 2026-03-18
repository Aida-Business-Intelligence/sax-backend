# Seções e Tags — site e painel

## Ideia geral

- **Tags** são etiquetas cadastráveis (ex: Frente Mar, Luxo, Lançamento). Um imóvel pode ter várias tags.
- **Seções** são os blocos da home do site (ex: “Frente Mar”, “Destaques”). Cada seção pode ser **vinculada a uma tag**; no site, essa seção exibe os imóveis que têm essa tag.
- Assim, “Frente Mar” é ao mesmo tempo uma **tag** (usada no imóvel) e o nome de uma **seção** (vinculada a essa tag). Quem tem a tag “Frente Mar” aparece na seção Frente Mar.

---

## Backend (sax-backend)

### Modelos (Prisma)

- **Tag**: `id`, `name`, `slug`, `active`, `sortOrder`
- **Section**: `id`, `title`, `slug`, `tagId` (opcional), `sortOrder`, `active`  
  - Se `tagId` estiver preenchido, a seção mostra no site os imóveis que têm essa tag.
- **Property**: já com relação N:N com Tag (`PropertyTag`). No cadastro do imóvel você associa tags ao imóvel.

### Fluxo

1. No painel: cadastro de **Tags** (módulo “Tags”) → ex.: Frente Mar, Luxo.
2. No painel: cadastro de **Seções** (módulo “Seções do site”) → ex.: seção “Frente Mar” vinculada à tag “Frente Mar”.
3. No cadastro do **Imóvel**: escolha uma ou mais **tags** (lista vinda do backend).
4. No **site**: a home busca as seções ativas; para cada seção com `tagId`, busca imóveis publicados com essa tag e exibe no bloco (ex.: `PropertySection` com título “Frente Mar”).

---

## Painel (sax-frontend-pdv)

- **Cadastros → Seções do site** (`/secoes`): CRUD de seções (título, slug, tag vinculada, ordem). (Views completas a integrar com a API.)
- **Cadastros → Tags** (`/tags-imoveis`): CRUD de tags (nome, slug, ordem). (Views completas a integrar com a API.)
- **Cadastros → Imóveis**: no formulário de criar/editar imóvel, substituir (ou complementar) o campo de “tag livre” por **multiselect de tags** carregadas da API (sax-backend). Ao salvar, enviar os IDs das tags selecionadas.

---

## Site (sax-site-front)

- Home (ou página que tiver blocos por seção):
  1. Chamar a API para listar **seções** ativas, ordenadas por `sortOrder`.
  2. Para cada seção que tiver `tagId`, chamar a API de **imóveis** filtrando por `tag` (ou `tagId`) e `status=published`.
  3. Renderizar um bloco por seção (ex.: `PropertySection`) com o `title` da seção e os imóveis retornados.

Com isso, o imóvel cadastrado no painel com a tag “Frente Mar” passa a aparecer corretamente na seção “Frente Mar” do site.

---

## Resumo

| Onde        | O quê |
|------------|--------|
| Painel     | Módulos **Seções do site** e **Tags** para cadastro. |
| Cadastro imóvel | Vincular **tags** (lista do backend). |
| Backend    | Modelos **Tag**, **Section**, **Property** + **PropertyTag**; APIs para tags, seções e imóveis (com filtro por tag). |
| Site       | Listar seções; para cada seção com tag, buscar imóveis por tag e exibir no bloco. |

Site e painel ficam alinhados: um único cadastro de tags e seções, e no imóvel só vincular as tags; a exibição na seção é automática pela tag.
