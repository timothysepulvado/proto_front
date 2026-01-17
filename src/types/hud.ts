export type HudStatus = "active" | "pending" | "completed" | string;

export interface HudRoot {
  hud: HudConfig;
}

export interface HudConfig {
  meta: HudMeta;
  clients: HudClient[];
  intake: HudIntake;
  ui_options?: HudUiOptions;
  data_model?: HudDataModel;
  error_handling?: HudErrorHandling;
}

export interface HudMeta {
  version: string;
  product: string;
  surface: string;
  layout: {
    mode: string;
    inspiration: string;
    density: string;
    motion: {
      enabled: boolean;
      style: string;
      reduced_motion_supported: boolean;
    };
  };
  iconography: {
    chatbot_icon: {
      id: string;
      label: string;
      style: string;
      render: {
        type: string;
        asset_ref: string;
        fallback: string;
      };
      states: Record<string, string>;
    };
  };
  theme: {
    background?: {
      type: string;
      backdrop_filter: string;
      noise: string;
      scanlines: string;
      vignette: string;
    };
    palette: {
      primary: string;
      accent: string;
      cream: string;
      hud_cyan: string;
      hud_lime: string;
      danger: string;
      warning: string;
    };
    typography: {
      ui: string;
      display: string;
      mono: string;
    };
  };
}

export interface HudClient {
  id: string;
  name: string;
  brand_id?: string;
  internal_id?: string;
  brand_memory_id?: string;
  agentic_features_workflow?: string;
  dna?: string | null;
  runs?: number | string | null;
  status?: HudStatus;
  hitl_review_needed?: boolean;
  configuration?: {
    llm?: string;
    agent_tool?: string;
    creative_tool?: string;
  };
  switch_options?: {
    llm?: string[];
    agent_tool?: string[];
    creative_tool?: string[];
  };
  links?: {
    project_home?: string | null;
    brand_dna?: string | null;
    latest_run?: string | null;
    assets?: string[];
  };
}

export interface HudIntake {
  new_client_name: string;
  initial_configuration: {
    llm: string;
    agent_tool: string;
    creative_tool: string;
  };
  switch_options: {
    llm: string[];
    agent_tool: string[];
    creative_tool: string[];
  };
  workflow?: {
    steps: Array<{
      id: string;
      label: string;
      type: string;
      required: boolean;
      fields?: string[];
      swap_behavior?: string;
      accepted?: string[];
      mock_examples?: string[];
      options?: string[];
    }>;
    agentic_onboarding?: {
      enabled: boolean;
      behavior: string;
      outputs: string[];
    };
  };
}

export interface HudUiOptions {
  realistic_theme?: {
    hud_style?: string;
    panel_material?: string;
    component_library?: string;
    mock_asset_refs?: Record<string, string>;
    behavior_notes?: string[];
  };
}

export interface HudDataModel {
  supports_overflow?: boolean;
  overflow_strategy?: {
    type: string;
    max_visible: number;
    navigation: string;
    grouping: string;
  };
  empty_states?: {
    no_projects?: {
      clients: unknown[];
      message: string;
      cta: string;
    };
    missing_fields?: {
      behavior: string;
      placeholders: Record<string, string | boolean>;
    };
  };
  error_state_schema?: {
    error: {
      code: string;
      message: string;
      details: {
        source: string;
        client_id: string | null;
        retryable: boolean;
        timestamp: string;
      };
    };
  };
}

export interface HudErrorHandling {
  missing_fields?: string;
  project_overflow?: string;
  config_error?: {
    error: {
      code: string;
      message: string;
      details: {
        source: string;
        client_id: string | null;
        retryable: boolean;
        timestamp: string;
      };
    };
    ui_behavior: string;
  };
}
