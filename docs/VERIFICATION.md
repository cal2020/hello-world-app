# Verification record

This file records how the scientific content was checked and which automated
and manual checks were run on the application, with their actual results.

## 1. Scientific sources

### Method

The content model keeps every number in `src/content/science.ts` together
with the sources that support it; prose lives in the locale files. Each source
in `src/content/sources.ts` has a `status` and a `note` explaining how it was
checked:

- **verified (73 of 100):** the source's URL, title and supporting statement
  were confirmed through search-engine records of the publisher, NCBI Bookshelf,
  BioNumbers or other authoritative pages. Direct page fetching was blocked by
  the build environment's network policy (NCBI, doi.org, publishers, BioNumbers
  and Wikipedia all returned connection errors), so the search record is the
  evidence; each `note` says what the record showed.
- **pending (27 of 100):** well-known publications recorded from the author's
  knowledge, with standard citations and DOI links, that could not be checked
  because the environment's web-search budget was exhausted. In the interface
  these sources are labelled **“not yet verified”**, and the 52 statements that
  rely on them carry a **“Verification pending”** tag (reading panel, text
  atlas and static pages).

Numbers keep their measurement context (cell type, species, experimental
setting) next to the value; the content tests check that every claim cites an
existing source and that every source is cited.

### How to finish the verification

1. Run `npm run check:links` from a machine with normal internet access. It
   checks all 100 URLs plus DOIs, reports broken links and lists the ones that
   publishers block for automated requests ("check manually").
2. For each source below, open the link, confirm the bibliographic data, and
   confirm that it supports the statements listed in the last column (the
   statement keys are `structure.field` in `src/content/science.ts`; the wording
   is under `structures.<id>` in `src/i18n/locales/en.json`).
3. Set `status: 'verified'` and replace the `note` in `src/content/sources.ts`,
   and remove `pending: true` from the claims in `src/content/science.ts` once
   all their sources are verified. Correct any number that does not match.

### Sources still to verify

| Source id | Citation | Link | Statements that rely on it |
| --- | --- | --- | --- |
| `beck-hurt-2017` | Beck M, Hurt E (2017). The nuclear pore complex: understanding its function through structural insight. *Nature Reviews Molecular Cell Biology 18(2):73–89* | https://doi.org/10.1038/nrm.2016.147 | nucleus.facts.pore-size, nucleus.function |
| `ribbeck-gorlich-2001` | Ribbeck K, Görlich D (2001). Kinetic analysis of translocation through nuclear pore complexes. *EMBO Journal 20(6):1320–1330* | https://doi.org/10.1093/emboj/20.6.1320 | nucleus.facts.pore-traffic |
| `luger-1997` | Luger K, Mäder AW, Richmond RK, Sargent DF, Richmond TJ (1997). Crystal structure of the nucleosome core particle at 2.8 Å resolution. *Nature 389(6648):251–260* | https://doi.org/10.1038/38444 | chromosomes.facts.nucleosome |
| `moyzis-1988` | Moyzis RK, Buckingham JM, Cram LS, Dani M, Deaven LL, Jones MD, Meyne J, Ratliff RL, Wu JR (1988). A highly conserved repetitive DNA sequence, (TTAGGG)n, present at the telomeres of human chromosomes. *Proceedings of the National Academy of Sciences USA 85(18):6622–6626* | https://doi.org/10.1073/pnas.85.18.6622 | telomeres.facts.repeat, telomeres.description |
| `griffith-1999` | Griffith JD, Comeau L, Rosenfield S, Stansel RM, Bianchi A, Moss H, de Lange T (1999). Mammalian telomeres end in a large duplex loop. *Cell 97(4):503–514* | https://doi.org/10.1016/S0092-8674(00)80760-6 | telomeres.facts.t-loop, telomeres.function |
| `de-lange-2005` | de Lange T (2005). Shelterin: the protein complex that shapes and safeguards human telomeres. *Genes & Development 19(18):2100–2110* | https://doi.org/10.1101/gad.1346005 | telomeres.facts.shelterin, telomeres.description, telomeres.function |
| `harley-1990` | Harley CB, Futcher AB, Greider CW (1990). Telomeres shorten during ageing of human fibroblasts. *Nature 345(6274):458–460* | https://doi.org/10.1038/345458a0 | telomeres.facts.shortening, telomeres.function |
| `greider-blackburn-1985` | Greider CW, Blackburn EH (1985). Identification of a specific telomere terminal transferase activity in Tetrahymena extracts. *Cell 43(2 Pt 1):405–413* | https://doi.org/10.1016/0092-8674(85)90170-9 | telomeres.facts.telomerase, telomeres.function |
| `aubert-lansdorp-2008` | Aubert G, Lansdorp PM (2008). Telomeres and aging. *Physiological Reviews 88(2):557–579* | https://doi.org/10.1152/physrev.00026.2007 | telomeres.typicalSize |
| `lewis-tollervey-2000` | Lewis JD, Tollervey D (2000). Like attracts like: getting RNA processing together in the nucleus. *Science 288(5470):1385–1389* | https://doi.org/10.1126/science.288.5470.1385 | nucleolus.facts.production, nucleolus.function |
| `boisvert-2007` | Boisvert FM, van Koningsbruggen S, Navascués J, Lamond AI (2007). The multifunctional nucleolus. *Nature Reviews Molecular Cell Biology 8(7):574–585* | https://doi.org/10.1038/nrm2184 | nucleolus.typicalSize, nucleolus.typicalQuantity, nucleolus.facts.layers, nucleolus.description, nucleolus.function |
| `feric-2016` | Feric M, Vaidya N, Harmon TS, Mitrea DM, Zhu L, Richardson TM, Kriwacki RW, Pappu RV, Brangwynne CP (2016). Coexisting liquid phases underlie nucleolar subcompartments. *Cell 165(7):1686–1697* | https://doi.org/10.1016/j.cell.2016.04.047 | nucleolus.facts.liquid |
| `hu-2011` | Hu J, Prinz WA, Rapoport TA (2011). Weaving the web of ER tubules. *Cell 147(6):1226–1231* | https://doi.org/10.1016/j.cell.2011.11.022 | smooth-er.typicalSize |
| `yildiz-2004` | Yildiz A, Tomishige M, Vale RD, Selvin PR (2004). Kinesin walks hand-over-hand. *Science 303(5658):676–678* | https://doi.org/10.1126/science.1093753 | vesicles-motors.facts.head-step |
| `schnitzer-block-1997` | Schnitzer MJ, Block SM (1997). Kinesin hydrolyses one ATP per 8-nm step. *Nature 388(6640):386–390* | https://doi.org/10.1038/41111 | vesicles-motors.facts.atp |
| `anderson-1981` | Anderson S, Bankier AT, Barrell BG, et al. (1981). Sequence and organization of the human mitochondrial genome. *Nature 290(5806):457–465* | https://doi.org/10.1038/290457a0 | mitochondria.facts.mtdna |
| `noji-1997` | Noji H, Yasuda R, Yoshida M, Kinosita K Jr (1997). Direct observation of the rotation of F1-ATPase. *Nature 386(6622):299–302* | https://doi.org/10.1038/386299a0 | mitochondria.facts.atp-per-turn, mitochondria.function |
| `watt-2010` | Watt IN, Montgomery MG, Runswick MJ, Leslie AGW, Walker JE (2010). Bioenergetic cost of making an adenosine triphosphate molecule in animal mitochondria. *Proceedings of the National Academy of Sciences USA 107(39):16823–16827* | https://doi.org/10.1073/pnas.1011099107 | mitochondria.facts.atp-per-turn, mitochondria.facts.protons, mitochondria.function |
| `mitchison-kirschner-1984` | Mitchison T, Kirschner M (1984). Dynamic instability of microtubule growth. *Nature 312(5991):237–242* | https://doi.org/10.1038/312237a0 | microtubules.interesting, microtubules.facts.instability, microtubules.function |
| `mullins-1998` | Mullins RD, Heuser JA, Pollard TD (1998). The interaction of Arp2/3 complex with actin: nucleation, high affinity pointed end capping, and formation of branching networks of filaments. *Proceedings of the National Academy of Sciences USA 95(11):6181–6186* | https://doi.org/10.1073/pnas.95.11.6181 | actin.facts.branch-angle, actin.function |
| `pollard-1986` | Pollard TD (1986). Rate constants for the reactions of ATP- and ADP-actin with the ends of actin filaments. *Journal of Cell Biology 103(6):2747–2754* | https://doi.org/10.1083/jcb.103.6.2747 | actin.facts.barbed-rate, actin.function |
| `pollard-cooper-2009` | Pollard TD, Cooper JA (2009). Actin, a central player in cell shape and movement. *Science 326(5957):1208–1212* | https://doi.org/10.1126/science.1175862 | actin.typicalQuantity, actin.interesting, actin.facts.treadmilling, actin.facts.cortex, actin.description, actin.function |
| `herrmann-aebi-2016` | Herrmann H, Aebi U (2016). Intermediate filaments: structure and assembly. *Cold Spring Harbor Perspectives in Biology 8(11):a018242* | https://doi.org/10.1101/cshperspect.a018242 | intermediate-filaments.typicalSize, intermediate-filaments.facts.ulf, intermediate-filaments.facts.lamins, intermediate-filaments.facts.types, intermediate-filaments.description, intermediate-filaments.function |
| `szeverenyi-2008` | Szeverenyi I, Cassidy AJ, Chung CW, et al. (2008). The Human Intermediate Filament Database: comprehensive information on a gene family involved in many human diseases. *Human Mutation 29(3):351–360* | https://doi.org/10.1002/humu.20652 | intermediate-filaments.typicalQuantity, intermediate-filaments.facts.types |
| `kreplak-2005` | Kreplak L, Bär H, Leterrier JF, Herrmann H, Aebi U (2005). Exploring the mechanical behavior of single intermediate filaments. *Journal of Molecular Biology 354(3):569–577* | https://doi.org/10.1016/j.jmb.2005.09.092 | intermediate-filaments.interesting, intermediate-filaments.function |
| `nigg-raff-2009` | Nigg EA, Raff JW (2009). Centrioles, centrosomes, and cilia in health and disease. *Cell 139(4):663–678* | https://doi.org/10.1016/j.cell.2009.10.036 | centrosome.typicalSize, centrosome.typicalQuantity, centrosome.interesting, centrosome.facts.triplets, centrosome.facts.duplication, centrosome.facts.cilium, centrosome.description, centrosome.function |
| `bornens-2012` | Bornens M (2012). The centrosome in cells and organisms. *Science 335(6067):422–426* | https://doi.org/10.1126/science.1209037 | microtubules.facts.anchoring, centrosome.typicalSize, centrosome.facts.nucleation, centrosome.description, centrosome.function |

## 2. Automated checks

Environment: Linux container, Node.js 22.22.0, npm 10, Chromium 141
(Playwright 1.56.1 build 1194) with **SwiftShader software WebGL** (no GPU).

RESULTS_PLACEHOLDER

## 3. Browser inspection

Screens were inspected at desktop (1440×900 and 1280×800), tablet (1024×1366)
and phone (390×844) sizes in English and in other languages; the images are in
[docs/screenshots/](screenshots/). Live animation could only be inspected at the
low frame rates of software rendering (a few frames per second); motion timing
was therefore also checked through the code's pure time functions (close-up
animations are functions of biological time, so frozen frames are exact).

INSPECTION_PLACEHOLDER
